import { base32Decode, totp } from '../../scripts/totp';

// RFC 6238 appendix B, SHA-1 rows, truncated to 6 digits as authenticator apps do.
const rfcSecret = Buffer.from('12345678901234567890', 'ascii');

test.each([
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
])('TOTP at %i seconds is %s', (seconds, code) => {
  expect(totp(rfcSecret, seconds * 1000)).toBe(code);
});

test('base32 decodes the RFC secret', () => {
  expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').equals(rfcSecret)).toBe(true);
});

test('base32 refuses characters outside the alphabet', () => {
  expect(() => base32Decode('GEZ1')).toThrow('not base32');
});
