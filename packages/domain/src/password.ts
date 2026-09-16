/**
 * The shortest password an account may have.
 *
 * Declared here because both ends enforce it: the web form disables its submit
 * button below this length, and the server rejects the request. Two copies of
 * the number drift, and the drift is invisible -- the form lets a password
 * through and the server answers 400, or the form refuses one the server would
 * have taken. Change it here and both ends move together.
 *
 * The deployment's bootstrap administrator password (scripts/create-admin-password-hash.mjs)
 * keeps its own, stricter minimum on purpose; it is not an account password.
 */
export const MIN_PASSWORD_LENGTH = 6;
