/**
 * Logs the real error for debugging and shows the user a generic,
 * non-leaking message instead of raw Postgres/PostgREST error text
 * (which can expose table/column/constraint names to any authenticated
 * user probing the app).
 */
export const showUserError = (context, error) => {
  console.error(context, error);
  alert(`${context}. Please try again, or contact support if the problem continues.`);
};