/**
 * Erzeugt eine throttled Version von `fn`: max. ein Call pro `ms`,
 * mit trailing-Call, damit Bursts nicht zu vielen Calls führen.
 * @param {Function} fn
 * @param {number} ms
 * @returns {Function & {cancel: Function}}
 */
function throttleTrailing(fn, ms) {
    let timer = null;
    let last = 0;
    const throttled = (...args) => {
        const now = Date.now();
        const wait = ms - (now - last);
        if (wait > 0) {
            if (!timer) {
                timer = setTimeout(() => {
                    timer = null;
                    last = Date.now();
                    fn(...args);
                }, wait);
                if (timer.unref) timer.unref();
            }
            return;
        }
        last = now;
        fn(...args);
    };
    throttled.cancel = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };
    return throttled;
}

export { throttleTrailing };
