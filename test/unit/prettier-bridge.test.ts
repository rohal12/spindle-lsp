import { describe, it, expect } from 'vitest';
import { loadPrettier } from '../../src/plugins/format/prettier-bridge.js';
import { formatDocument } from '../../src/plugins/format.js';

describe('prettier-bridge', () => {
  it('loads Prettier with the resolved configuration over tabWidth 2', async () => {
    const setup = await loadPrettier();
    expect(setup).toBeDefined();
    expect(setup!.options).toMatchObject({ tabWidth: 2 });
    expect(await setup!.prettier.format('const   x=1', { parser: 'babel' })).toBe('const x = 1;\n');
  });

  it('formats script and stylesheet passages with it', async () => {
    const doc = ':: Code [script]\nconst   x=1;const y = 2\n\n:: Style [stylesheet]\n.foo{color:red;display:block}\n';
    expect(await formatDocument(doc)).toBe(
      ':: Code [script]\nconst x = 1;\nconst y = 2;\n\n:: Style [stylesheet]\n.foo {\n  color: red;\n  display: block;\n}\n',
    );
  });

  it('leaves code Prettier cannot parse as written', async () => {
    const doc = ':: Code [script]\nconst x = {{{\n\n:: Style [stylesheet]\n.foo { color: }}}\n';
    expect(await formatDocument(doc)).toBe(doc);
  });
});
