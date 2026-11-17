/**
 * Glob-Matcher für relative Pfade (POSIX-Slashes).
 *
 * Unterstützte Syntax:
 *   **    → beliebig viele Segmente (auch null), über `/` hinweg
 *   *     → beliebig viele Zeichen innerhalb eines Segments (kein `/`)
 *   ?     → genau ein Zeichen innerhalb eines Segments (kein `/`)
 *   [...] → Zeichenklasse (`!`/`^` = Negation)
 *   alles andere → Literal
 *
 * Semantik (wie gitignore/minimatch):
 *   `**` + `/*.md` → `a.md`, `a/b.md`, `a/b/c.md`
 *   `*.md`         → nur `a.md` (Root-Ebene), NICHT `a/b.md`
 *   `a/**`         → alles unter `a/`
 *
 * `matchesAny(relPath, patterns)`:
 *   - patterns leer/undefined/nicht-Array → true (kein Filter, alles erlaubt)
 *   - sonst: true, wenn mindestens ein gültiges Pattern matcht
 */

/**
 * Wandelt ein Glob-Pattern in eine RegExp um.
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegex(pattern) {
    let regex = '';
    let i = 0;
    const len = pattern.length;

    while (i < len) {
        const c = pattern[i];

        if (c === '*') {
            if (pattern[i + 1] === '*') {
                // `**` (möglicherweise gefolgt von `/`)
                let j = i;
                while (j < len && pattern[j] === '*') j++;
                if (j < len && pattern[j] === '/') {
                    // `**/` → null oder mehr Verzeichnisse
                    regex += '(?:.*/)?';
                    i = j + 1;
                } else {
                    // `**` am Ende oder vor anderem Zeichen → alles
                    regex += '.*';
                    i = j;
                }
                continue;
            }
            // `*` → beliebig viele Zeichen außer `/`
            regex += '[^/]*';
            i++;
            continue;
        }

        if (c === '?') {
            // `?` → genau ein Zeichen außer `/`
            regex += '[^/]';
            i++;
            continue;
        }

        if (c === '[') {
            // Zeichenklasse
            let j = i + 1;
            let cls = '[';
            if (pattern[j] === '!' || pattern[j] === '^') {
                cls += '^';
                j++;
            }
            if (pattern[j] === ']') {
                cls += ']';
                j++;
            }
            while (j < len && pattern[j] !== ']') {
                cls += pattern[j];
                j++;
            }
            if (j >= len) {
                // kein schließendes `]` → `[` als Literal behandeln
                regex += '\\[';
                i++;
                continue;
            }
            cls += ']';
            regex += cls;
            i = j + 1;
            continue;
        }

        // Regex-Sonderzeichen escapen
        if ('\\^$.|+(){}'.includes(c)) {
            regex += '\\' + c;
        } else {
            regex += c;
        }
        i++;
    }

    return new RegExp('^' + regex + '$');
}

/**
 * Prüft, ob ein relativer Pfad mindestens ein Pattern der Whitelist erfüllt.
 * Leere/fehlende Whitelist → true (kein Filter).
 * @param {string} relPath - Pfad relativ zum Root (POSIX-Slashes)
 * @param {string[] | undefined | null} patterns - Glob-Patterns
 * @returns {boolean}
 */
function matchesAny(relPath, patterns) {
    if (!Array.isArray(patterns) || patterns.length === 0) return true;
    const path = String(relPath ?? '').split('\\').join('/');
    return patterns.some((p) => {
        if (typeof p !== 'string') return false;
        const trimmed = p.trim();
        if (trimmed === '') return false;
        try {
            return globToRegex(trimmed).test(path);
        } catch {
            return false;
        }
    });
}

export { globToRegex, matchesAny };
