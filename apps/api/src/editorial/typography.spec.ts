import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_TEXT_TYPOGRAPHY, parseTextTypography, textTypographyClasses } from './typography';

test('fontes autorizadas e classes tipográficas estão restritas a opções locais', () => {
  assert.equal(parseTextTypography(DEFAULT_TEXT_TYPOGRAPHY)?.font, 'system');
  const variant = { font: 'mono', size: 'small', align: 'center', bold: true, italic: true };
  assert.deepEqual(parseTextTypography(variant), variant);
  assert.equal(textTypographyClasses(parseTextTypography(variant)!),
    'cms-type-mono cms-type-size-small cms-type-align-center cms-type-bold cms-type-italic');
});

test('nomes CSS/valores externos são recusados na fronteira de tipografia', () => {
  for (const variant of [
    { ...DEFAULT_TEXT_TYPOGRAPHY, font: 'Comic Sans; background:url(x)' },
    { ...DEFAULT_TEXT_TYPOGRAPHY, size: '200px' },
    { ...DEFAULT_TEXT_TYPOGRAPHY, align: 'center;display:none' },
    { ...DEFAULT_TEXT_TYPOGRAPHY, bold: 1 },
    { ...DEFAULT_TEXT_TYPOGRAPHY, extra: 'surprise' },
    { font: 'georgia' },
  ]) assert.equal(parseTextTypography(variant), null);
  assert.equal(parseTextTypography(null), null);
  assert.equal(parseTextTypography([]), null);
});
