package io.missiongo.android.badge

import java.util.ArrayDeque
import java.util.concurrent.Executor
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The serial-dedup contract of [LatestCountPublisher] (AND-185). Every test
 * queues drains instead of running them in place; [QueuedExecutor.runAll]
 * then plays the publisher's single background thread. That is what makes the
 * conflating observable: offers stack up against a busy (or not yet started)
 * consumer, which is exactly the situation on a device when two fetches land
 * close together.
 */
class LatestCountPublisherTest {
    private val executor = QueuedExecutor()

    /** Queues drains like a real background thread would; runAll() runs them in order. */
    private class QueuedExecutor : Executor {
        private val queue = ArrayDeque<Runnable>()

        override fun execute(command: Runnable) {
            queue.addLast(command)
        }

        fun runAll() {
            while (queue.isNotEmpty()) queue.removeFirst().run()
        }
    }

    private fun publisher(accept: (Int) -> Boolean = { true }): Pair<LatestCountPublisher, MutableList<Int>> {
        val pushed = mutableListOf<Int>()
        val publisher = LatestCountPublisher(
            push = { count ->
                pushed += count
                accept(count)
            },
            executor = executor,
        )
        return publisher to pushed
    }

    /**
     * The HG-103 shape: 1 then 0 from two fetches landing together. A
     * superseded count never leaves, and what leaves is in order, so the icon
     * can never end up holding 1 while the publisher believes 0 is out.
     */
    @Test
    fun onlyTheNewestCountIsPushedAndNeverOutOfOrder() {
        val (publisher, pushed) = publisher()
        publisher.offer(1)
        publisher.offer(0)
        executor.runAll()
        assertEquals(listOf(0), pushed)

        publisher.offer(1)
        executor.runAll()
        publisher.offer(0)
        executor.runAll()
        assertEquals(listOf(0, 1, 0), pushed)
    }

    @Test
    fun aCountTheLauncherAlreadyHoldsIsNotPushedAgain() {
        val (publisher, pushed) = publisher()
        publisher.offer(2)
        executor.runAll()
        publisher.offer(2)
        executor.runAll()
        assertEquals(listOf(2), pushed)
    }

    /**
     * A push the launcher refused is not remembered as published, so the same
     * count is retried rather than swallowed by the dedup.
     */
    @Test
    fun aFailedPushIsRetriedOnTheNextOfferOfTheSameCount() {
        var accept = false
        val (publisher, pushed) = publisher { accept }
        publisher.offer(3)
        executor.runAll()
        accept = true
        publisher.offer(3)
        executor.runAll()
        publisher.offer(3)
        executor.runAll()
        assertEquals(listOf(3, 3), pushed)
    }

    /** A failed push must not block the counts that come after it. */
    @Test
    fun aFailedPushDoesNotHoldBackANewerCount() {
        var accept = false
        val (publisher, pushed) = publisher { accept }
        publisher.offer(3)
        executor.runAll()
        accept = true
        publisher.offer(2)
        executor.runAll()
        assertEquals(listOf(3, 2), pushed)
    }

    /** Zero travels like any other count: clearing the badge is a push, not a special case. */
    @Test
    fun zeroIsPushedWhenItSupersedesSomething() {
        val (publisher, pushed) = publisher()
        publisher.offer(1)
        publisher.offer(0)
        executor.runAll()
        publisher.offer(0)
        executor.runAll()
        assertEquals(listOf(0), pushed)
    }
}
