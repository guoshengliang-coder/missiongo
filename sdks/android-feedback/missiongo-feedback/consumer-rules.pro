# WorkManager persists this class name between process starts.
-keep class io.missiongo.feedback.internal.FeedbackSubmissionWorker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}
