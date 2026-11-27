/**
 * Conventions shared by the `wx` APIs: callbacks and Promises, `errMsg` and
 * `errno`, and the tap state some APIs require.
 */

export type AnyFunction = (...args: any[]) => any;
export type Options = Record<string, any> & {
  success?: AnyFunction;
  fail?: AnyFunction;
  complete?: AnyFunction;
};

/** An API failure; `errno` is set where WeChat sets one. */
export class ApiError extends Error {
  readonly errno?: number;
  constructor(message: string, errno?: number) {
    super(message);
    this.errno = errno;
  }
}

/**
 * Whether code runs in response to a user tap. WeChat keeps this state for the
 * tap handler and its microtasks, loses it after `setTimeout`, and passes it on
 * to the callbacks of a few APIs such as `wx.login`.
 */
let tapGesture = false;
/** Whether code runs with the tap state now. */
export const hasTapGesture = () => tapGesture;
let tapGestureReset: ReturnType<typeof setTimeout> | undefined;

/** Runs a tap or button open-type handler with the tap state. */
export function runWithTapGesture(run: () => void) {
  tapGesture = true;
  // The state ends with the current macrotask; entering it again from a microtask does not extend it
  tapGestureReset ??= setTimeout(() => {
    tapGesture = false;
    tapGestureReset = undefined;
  }, 0);
  run();
}

/** Calls API callbacks, with the tap state when the call was made with it. */
export function respond(callbacks: (AnyFunction | undefined)[], result: unknown, tapped: boolean) {
  const call = () => callbacks.forEach((callback) => safeCall(callback, result));
  if (tapped) runWithTapGesture(call);
  else call();
}

export const requireTapGesture = () => {
  if (!tapGesture) throw new Error("can only be invoked by user TAP gesture.");
};

export interface AsyncApiOptions {
  /** False for APIs that return no Promise when called without callbacks. */
  promise?: boolean;
  /** Whether callbacks keep the tap state of the call. */
  passesTapGesture?: boolean;
}

/** Calls an async API implementation with WeChat's callback and Promise conventions. */
export function asyncApi(
  name: string,
  impl: (options: Options) => Promise<Record<string, unknown>>,
  { promise: returnsPromise = true, passesTapGesture = false }: AsyncApiOptions = {},
) {
  return (options: Options = {}) => {
    const tapped = tapGesture;
    const promise = Promise.resolve()
      .then(() => impl(options))
      .then(
        (result) => ({ errMsg: `${name}:ok`, ...result }),
        (error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          const errno = error instanceof ApiError ? error.errno : undefined;
          throw {
            errMsg: `${name}:fail ${reason}`.trimEnd(),
            ...(errno === undefined ? {} : { errno }),
          };
        },
      );
    if (!options.success && !options.fail && !options.complete) {
      if (returnsPromise) return promise;
      promise.catch(() => {});
      return undefined;
    }
    const keepTap = passesTapGesture && tapped;
    promise.then(
      (result) => respond([options.success, options.complete], result, keepTap),
      (error) => respond([options.fail, options.complete], error, keepTap),
    );
    return undefined;
  };
}

export function safeCall(fn: AnyFunction | undefined, arg: unknown) {
  if (typeof fn !== "function") return;
  try {
    fn(arg);
  } catch (error) {
    console.error("[omr] error in API callback:", error);
  }
}
