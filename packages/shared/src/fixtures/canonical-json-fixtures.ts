export type CanonicalJsonFixture = {
  readonly name: string
  readonly value: unknown
  readonly canonical: string
  readonly hash: string
}

export const canonicalJsonFixtures: readonly CanonicalJsonFixture[] = [
  { name: "null", value: null, canonical: "null", hash: "sha256:74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b" },
  { name: "primitive string", value: "ApplyMate", canonical: '"ApplyMate"', hash: "sha256:4d4c19911a539813b15dfd272dcdbc6adbf70cd719dabf698d945b1e8ccf5704" },
  { name: "nested object", value: { b: 2, a: { d: true, c: null } }, canonical: '{"a":{"c":null,"d":true},"b":2}', hash: "sha256:53a7386464926d88924478cc8537bacb8ec836469d2f41f60f86d7b226a9f4c8" },
  { name: "ordered array", value: ["resume", 1, false], canonical: '["resume",1,false]', hash: "sha256:1642a564046b94c0b7d3ec22de02c00cef972cfd54de9dd15959407e509876cf" },
  { name: "unicode keys", value: { z: "last", "ä": "unicode", a: "first" }, canonical: '{"a":"first","z":"last","ä":"unicode"}', hash: "sha256:2172313d4b753b92bf6cb0b65bb76bf02aba205feb1f31451c2d91e9452653d9" },
]
