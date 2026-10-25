/** Mutable app context shared across domain modules. Filled by main/app bootstrap. */
export const ctx = {};
export function setCtx(partial) {
  Object.assign(ctx, partial);
  return ctx;
}
