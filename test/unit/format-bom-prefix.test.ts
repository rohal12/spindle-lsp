import { expect, it } from 'vitest';
import { parseTwee } from '@rohal12/twee-ts';
import { formatDocument } from '../../src/plugins/format.js';

it.each(['\n', '\r\n', '\r'])('preserves entire BOM prefixes and compiler identity with %j endings (#291)', async eol => {
  for (const count of [0, 1, 3, 10_000]) {
    const prefix = '\uFEFF'.repeat(count);
    const text = prefix + `:: Start${eol}Hello${eol}`;
    expect(parseTwee(text).passages.map(p => p.name)).toEqual(['Start']);
    const output = await formatDocument(text);
    expect(output).toBe(text);
    expect(parseTwee(output).passages).toEqual(parseTwee(text).passages);
    expect(await formatDocument(output)).toBe(output);
  }
});
