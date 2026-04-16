export const LANGUAGES = [
  { code: 'en', name: 'English' },
  {
    code: 'zh',
    name: 'Chinese',
    profanityGuidance: 'If the variant requires profanity/curse words, use natural Chinese (Mandarin) curse words — for example: 妈的, 他妈的, 操, 该死, 靠, 狗屁, 见鬼. NEVER leave English curse words ("fuck", "fucking", "shit", "hell", "goddamn", "motherfucker", "damn") in the output; always translate them into the nearest Chinese equivalent that fits the character.',
  },
];

export function getLanguage(code) {
  return LANGUAGES.find((l) => l.code === code) || { code, name: code };
}
