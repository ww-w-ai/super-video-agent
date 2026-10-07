# Reusable speaker voices

Keep each speaker's language voices in one cast file. Plans reference it with
`meta.cast`, relative to the plan directory or absolute. Each speaking line sets
`speaker`. Reuse the same cast file across videos.

```json
{
  "speakers": {
    "speaker1": {
      "voices": {
        "ko": { "provider": "file", "voiceId": "voice-ko" },
        "en": { "provider": "file", "voiceId": "voice-en" }
      }
    }
  }
}
```

Use the existing voice configuration fields. Set the provider explicitly in each
mapping. Reference audio and token paths resolve from the cast file directory.
The voice command reads the mapping on every run. It does not copy voice settings
into the plan. Dub scaffolding keeps speaker IDs and adjusts the cast reference.

The line's `lang` wins over `meta.lang`. Exact language tags win. Otherwise one
matching written language is required. Missing and ambiguous mappings stop before
synthesis. Script differences remain distinct. For example, `zh-Hans` does not
match `zh-Hant`.

Do not duplicate speaker identity fields in `line.voice`. Keep provider, voice ID,
model and reference clips in the cast file. Nonidentity line settings remain
available and override cast defaults. Lines without
`speaker` keep the existing voice behavior.
