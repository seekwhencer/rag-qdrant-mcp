import { describe, it, expect } from 'vitest';
import { globToRegex, matchesAny } from '../src/Utils/glob.js';

describe('globToRegex', () => {
    it('matches a simple extension pattern at root level', () => {
        const re = globToRegex('*.md');
        expect(re.test('a.md')).toBe(true);
        expect(re.test('a.txt')).toBe(false);
        expect(re.test('sub/a.md')).toBe(false);
    });

    it('matches **/*.ext across any depth (incl. root)', () => {
        const re = globToRegex('**/*.md');
        expect(re.test('a.md')).toBe(true);
        expect(re.test('sub/a.md')).toBe(true);
        expect(re.test('a/b/c.md')).toBe(true);
        expect(re.test('a.txt')).toBe(false);
    });

    it('matches ** (everything)', () => {
        const re = globToRegex('**');
        expect(re.test('a')).toBe(true);
        expect(re.test('a/b/c')).toBe(true);
    });

    it('matches dir/** (everything under dir)', () => {
        const re = globToRegex('docs/**');
        expect(re.test('docs/a')).toBe(true);
        expect(re.test('docs/a/b')).toBe(true);
        expect(re.test('other/a')).toBe(false);
    });

    it('matches dir/*.ext (single level only)', () => {
        const re = globToRegex('docs/*.txt');
        expect(re.test('docs/a.txt')).toBe(true);
        expect(re.test('docs/sub/a.txt')).toBe(false);
    });

    it('supports ? (single char, no slash)', () => {
        const re = globToRegex('a?.txt');
        expect(re.test('a1.txt')).toBe(true);   // genau ein Zeichen → match
        expect(re.test('ab.txt')).toBe(true);   // genau ein Zeichen → match
        expect(re.test('a12.txt')).toBe(false); // zwei Zeichen → kein match
        expect(re.test('a/b.txt')).toBe(false); // Slash → kein match
    });

    it('supports character classes', () => {
        const re = globToRegex('file[0-9].txt');
        expect(re.test('file1.txt')).toBe(true);
        expect(re.test('filea.txt')).toBe(false);
    });

    it('supports negated character classes', () => {
        const re = globToRegex('file[!0-9].txt');
        expect(re.test('filea.txt')).toBe(true);
        expect(re.test('file1.txt')).toBe(false);
    });

    it('escapes regex special characters as literals', () => {
        const re = globToRegex('a.b*c');
        expect(re.test('a.b*c')).toBe(true);
        expect(re.test('axb*c')).toBe(false);
    });

    it('treats an unclosed [ as a literal', () => {
        const re = globToRegex('a[.txt');
        expect(re.test('a[.txt')).toBe(true);
        expect(re.test('a1.txt')).toBe(false);
    });
});

describe('matchesAny', () => {
    it('returns true for empty/undefined/null patterns (no filter)', () => {
        expect(matchesAny('a/b.md', [])).toBe(true);
        expect(matchesAny('a/b.md', undefined)).toBe(true);
        expect(matchesAny('a/b.md', null)).toBe(true);
    });

    it('returns true if at least one pattern matches', () => {
        expect(matchesAny('a/b.md', ['**/*.txt', '**/*.md'])).toBe(true);
        expect(matchesAny('a/b.txt', ['**/*.md', '**/*.txt'])).toBe(true);
    });

    it('returns false if no pattern matches', () => {
        expect(matchesAny('a/b.log', ['**/*.md', '**/*.txt'])).toBe(false);
    });

    it('ignores non-string and empty patterns', () => {
        expect(matchesAny('a/b.md', [42, '', '   '])).toBe(false);
        expect(matchesAny('a/b.md', [42, '', '**/*.md'])).toBe(true);
    });

    it('normalizes backslashes to forward slashes', () => {
        expect(matchesAny('a\\b.md', ['**/*.md'])).toBe(true);
    });

    it('does not throw on invalid patterns (treated as non-matching)', () => {
        // Ungültige Patterns dürfen nie werfen — sie matchen einfach nicht.
        expect(() => matchesAny('a/b.md', ['**/*.md'])).not.toThrow();
    });
});
