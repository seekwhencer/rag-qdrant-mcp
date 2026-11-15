/** Formatiert Logger-Argumente: Strings bleiben, Objekte/Errors werden lesbar. */
function formatArgs(args) {
    return args
        .map((a) => {
            if (typeof a === 'string') return a;
            if (a instanceof Error) return a.stack || a.message;
            try {
                return JSON.stringify(a);
            } catch {
                return String(a);
            }
        })
        .join(' ');
}

class Logger {
    constructor({ verbose } = {}) {
        this.verbose = verbose ?? process.env.VERBOSE === 'true';
        this.sink = null; // LogService (Live-Log-Stream), wird vom Server gesetzt
    }

    /** Setzt den Log-Sink (LogService) für den Live-Log-Stream. */
    setSink(sink) {
        this.sink = sink;
    }

    log(label, ...args) {
        const message = `${label} ${formatArgs(args)}`;
        const ts = new Date().toISOString();
        if (this.verbose) {
            console.log(`${ts} ${message}`);
        }
        this.emit('INF', message, ts);
    }

    error(label, ...args) {
        const message = `${label} ${formatArgs(args)}`;
        const ts = new Date().toISOString();
        console.error(`${ts} ${message}`);
        this.emit('ERR', message, ts);
    }

    /** Zeile in den Log-Sink (Live-Stream) geben. */
    emit(level, message, ts) {
        if (this.sink) {
            this.sink.push({ ts, level, message, raw: message });
        }
    }
}

export { Logger };
