/**
 * Parst einen SSE (Server-Sent Events) Stream in JSON-Objekte.
 * @param {ReadableStream} body - Response-Body (Web ReadableStream)
 * @yields {object} Geparste JSON-Chunks
 */
async function* readSSE(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 1);
                const trimmed = line.trim();
                if (!trimmed || trimmed === 'data: [DONE]' || !trimmed.startsWith('data:')) continue;
                const payload = trimmed.slice(5).trim();
                if (payload === '') continue;
                try { yield JSON.parse(payload); } catch {}
            }
        }
        const tail = decoder.decode();
        if (tail.trim() && tail.trim() !== 'data: [DONE]') {
            try { yield JSON.parse(tail.trim()); } catch {}
        }
    } finally {
        reader.releaseLock();
    }
}

/**
 * Parst einen NDJSON-Stream in JSON-Objekte.
 * @param {ReadableStream} body - Response-Body (Web ReadableStream)
 * @yields {object} Geparste JSON-Chunks
 */
async function* readNDJSON(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, idx).trim();
                buffer = buffer.slice(idx + 1);
                if (line === '') continue;
                try { yield JSON.parse(line); } catch {}
            }
        }
        const tail = buffer.trim();
        if (tail) {
            try { yield JSON.parse(tail); } catch {}
        }
    } finally {
        reader.releaseLock();
    }
}

export { readSSE, readNDJSON };
