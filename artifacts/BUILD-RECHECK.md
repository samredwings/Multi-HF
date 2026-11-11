# Multi-HF v0.2.0 corrected build — recheck record

This record tracks the locally rechecked source bundle associated with this branch.

- Uploaded source ZIP SHA-256: `883604a4832c124f16a1a7874801b3f919547026fada15290ae502c008bb2215`
- Reconstructed source tar SHA-256: `87b57158af53dff1846e26d4685f788fba74e28418755e5779e1c736fea66866`

## Local checks reported for the bundle

| Check | Result |
|---|---|
| ZIP integrity | Passed |
| `npm ci` | Passed |
| `npm run check` | Passed |
| `npm test` | 54/54 passed |
| `npm run build` | Passed |
| `npm run build:android-assets` | Passed |
| `npm audit` | 0 reported vulnerabilities |

Android `assembleDebug` and `lintDebug` were not verified because the Android SDK/Gradle wrapper environment was unavailable.

This is a verification record only. It does not assert that the ZIP archive itself has been committed to Git.
