// Daily rotation of warm, self-affirming messages for Bashaier (H94830).
// Chosen to support self-confidence and counter inner self-criticism; each
// is short enough to sit on one line with the trailing fairy emoji. The
// pick is deterministic per calendar day, so it stays stable through the
// day and rotates at midnight rather than changing on every render.

export const DAILY_MESSAGES = [
  { lang: 'en', text: 'You are enough, exactly as you are right now' },
  { lang: 'en', text: 'Your sensitivity is a strength, not a flaw' },
  { lang: 'en', text: "You don't have to be perfect to be valued" },
  { lang: 'en', text: 'Be gentle with yourself today — you deserve it' },
  { lang: 'en', text: "Your worth isn't measured by what you achieve" },
  { lang: 'en', text: 'You belong here, just as you are' },
  { lang: 'en', text: 'Every feeling you have is valid' },
  { lang: 'en', text: 'You are stronger than you think you are' },
  { lang: 'en', text: 'Your light is real, even on the dim days' },
  { lang: 'en', text: "You don't need to earn your place — it is already yours" },
  { lang: 'en', text: 'The world is softer because you are in it' },
  { lang: 'en', text: 'You are doing better than you give yourself credit for' },
  { lang: 'en', text: 'Your kindness leaves a mark wherever you go' },
  { lang: 'en', text: 'Today, choose softness over self-criticism' },
  { lang: 'en', text: 'You are loved, even on the days you doubt it' },
  { lang: 'en', text: 'Rest is not weakness — it is wisdom' },
  { lang: 'en', text: 'You are allowed to take up space and be heard' },
  { lang: 'ar', text: 'أنتِ كافية، تماماً كما أنتِ' },
  { lang: 'ar', text: 'حساسيتك قوة، وليست ضعفاً' },
  { lang: 'ar', text: 'كوني لطيفة مع نفسك، أنتِ تستحقين ذلك' },
  { lang: 'ar', text: 'قيمتك لا تقاس بإنجازاتك' },
  { lang: 'ar', text: 'أنتِ تنتمين هنا، تماماً كما أنتِ' },
  { lang: 'ar', text: 'كل مشاعرك صحيحة ومستحقة' },
  { lang: 'ar', text: 'أنتِ أقوى مما تظنين' },
  { lang: 'ar', text: 'نورك حقيقي حتى في الأيام الباهتة' },
  { lang: 'ar', text: 'أنتِ تقومين بعمل أفضل مما تدركين' },
  { lang: 'ar', text: 'العالم أجمل لأنكِ فيه' },
  { lang: 'ar', text: 'اختاري اللطف مع نفسك اليوم' },
  { lang: 'ar', text: 'أنتِ محبوبة، حتى في الأيام التي تشككين فيها' },
];

// Returns the { lang, text } for the given date (defaults to today),
// rotating once per local calendar day.
export function dailyMessage(date = new Date()) {
  const dayIndex = Math.floor(
    (date.getTime() - date.getTimezoneOffset() * 60000) / 86400000
  );
  const idx = ((dayIndex % DAILY_MESSAGES.length) + DAILY_MESSAGES.length) % DAILY_MESSAGES.length;
  return DAILY_MESSAGES[idx];
}
