import { expect, it } from 'vitest'
import { cliReturnTo, safeSignInNext } from './sessionNavigation'

it('canonicalizes only a bounded CLI consent code', () => {
  expect(cliReturnTo('/cli/approve?code=abcd-efgh')).toBe('/cli/approve?code=ABCD-EFGH')
})

it.each([
  undefined, '', 'https://evil.example/cli/approve?code=ABCD-EFGH',
  '//evil.example/cli/approve?code=ABCD-EFGH', '/\\evil.example',
  '/cli/approve?code=ABCD-EFGH&next=https://evil.example',
  '/cli/approve?code=ABCD-EFGH#extra', '/cli/approve?code=AAAA-0000',
  '/cli/approve?code=ABCD%2DEFGH', '/onboarding',
])('rejects non-consent email context %s', (value) => {
  expect(cliReturnTo(value)).toBeUndefined()
})

it.each(['https://evil.example', '//evil.example', '/\\evil.example', '/\n/evil.example', '/\t/evil.example', 'javascript:alert(1)'])('blocks unsafe post-sign-in destination %s', (value) => {
  expect(safeSignInNext(value)).toBe('/')
})

it.each(['/onboarding', '/w/lab', '/cli/approve?code=ABCD-EFGH'])('preserves internal destination %s', (value) => {
  expect(safeSignInNext(value)).toBe(value)
})
