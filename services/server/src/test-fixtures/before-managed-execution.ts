import type { DatabaseSync } from "node:sqlite";

/** Synthetic historical databases must not retain newer cross-table triggers. */
export function beforeManagedExecution(connection: DatabaseSync): void {
  connection.exec(`
    DROP TRIGGER IF EXISTS managed_manual_insert;
    DROP TRIGGER IF EXISTS managed_manual_start;
    DROP TRIGGER IF EXISTS managed_manual_reacquire;
    DROP TRIGGER IF EXISTS managed_manual_message_generation;
    DROP TRIGGER IF EXISTS managed_manual_settings_generation;
    DROP TRIGGER IF EXISTS managed_manual_restore_generation;
    DROP TRIGGER IF EXISTS managed_manual_message;
    DROP TRIGGER IF EXISTS managed_manual_settings;
    DROP TRIGGER IF EXISTS managed_manual_restore;
    DROP TABLE managed_execution_inputs;
    DROP TABLE managed_execution_events;
    DROP TABLE managed_execution_observations;
    DROP TABLE managed_execution_bindings;
    DROP TABLE managed_execution_intents;
    DROP TABLE managed_executor_registrations;
    DROP TABLE managed_manual_reconciliations;
    ALTER TABLE dispatches DROP COLUMN execution_generation;
    DELETE FROM schema_migrations WHERE version=202609270536;
  `);
}
