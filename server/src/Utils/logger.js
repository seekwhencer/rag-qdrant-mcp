/**
 * Noop-Logger (Default, wenn kein Logger injiziert ist).
 * @returns {{log: Function, error: Function}}
 */
function noopLogger() {
    return { log: () => {}, error: () => {} };
}

export { noopLogger };
