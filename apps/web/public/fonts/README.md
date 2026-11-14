# Offline PDF fonts

These fonts are served by ApplyMate from its own `/fonts/` path. No external font request is made while exporting.

- `NotoSans-Regular.ttf` comes from https://github.com/notofonts/noto-fonts/blob/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf (SHA-256 `b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5`). Its copyright notice and SIL OFL 1.1 are in `NotoSans-OFL.txt`.
- `NotoSansSC-GB2312-Regular.ttf` is a modified static 400-weight subset of https://github.com/google/fonts/blob/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf (original SHA-256 `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`; subset SHA-256 `059a7bac57f3eaf9ff02147a47ace9499b6950cd8c05d83a9d6bee53d924c04e`). The source copyright notice, Reserved Font Name, and SIL OFL 1.1 are in `NotoSansSC-OFL.txt`. The modified font does not use the reserved name as its primary font name.

The subset was generated with fontTools 4.55.7: instantiate the original variable TTF with `fontTools.varLib.instancer` at `wght=400`, then run `fontTools.subset` with `--text-file` containing all successfully decoded two-byte GB2312 sequences from first byte `0xA1..0xF7` and second byte `0xA1..0xFE`. It intentionally does not cover every CJK character. The regular Noto Sans font supplies European scripts. Bold fallback glyphs use the regular face; the existing built-in Latin bold fonts remain preferred.

`src/lib/application-pdf-coverage.ts` was generated as sorted inclusive hexadecimal ranges from the union of `TTFont(path).getBestCmap()` keys for these two shipped TTF files. Update that generated map whenever either font changes. Export normalizes CRLF/CR to LF, tabs to four spaces, nonbreaking spaces to ordinary spaces, and text to NFC in the PDF only; stored materials are unchanged. Remaining unsupported, combining and format characters and selected spacing/control characters are rejected before rendering; the map is not a claim of support for an entire language.
