import React from 'react';
import { ArrowRight, Check, Leaf, Compass, ShieldCheck, Clock, CalendarDays, Users } from 'lucide-react';
import EvergreenLogo from './EvergreenLogo.jsx';

export default function Landing({ onEnter }) {
  return (
    <div className="min-h-screen overflow-x-hidden">
      {/* ───────────── HERO ───────────── */}
      <section className="relative" style={{ background: 'var(--evergreen-900)', color: '#F4EEDF' }}>
        {/* Evergreen flowing lines */}
        <EvergreenLines />

        {/* Nav */}
        <nav className="relative z-10 max-w-7xl mx-auto px-6 py-6 flex items-center justify-between">
          <EvergreenLogo variant="full" size="md" light />
          <div className="flex items-center gap-2">
            <a href="#features" className="text-sm opacity-70 hover:opacity-100 px-3 py-2 hidden sm:inline">Features</a>
            <a href="#law" className="text-sm opacity-70 hover:opacity-100 px-3 py-2 hidden sm:inline">Saudi Law</a>
            <button onClick={onEnter}
              className="flex items-center gap-2 px-4 py-2 rounded-full text-sm transition-all"
              style={{ background: '#F4EEDF', color: 'var(--evergreen-900)' }}>
              Sign in <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </nav>

        {/* Hero content */}
        <div className="relative z-10 max-w-7xl mx-auto px-6 pt-20 pb-32 md:pt-32 md:pb-48">
          <div className="max-w-3xl">
            <div className="flex items-center gap-2 mb-8 text-xs tracking-[0.25em] opacity-70">
              <div className="w-8 h-px" style={{ background: 'var(--evergreen-300)' }} />
              VACATION · ABSENCE · ACCRUAL
            </div>
            <h1 className="serif text-[clamp(2.5rem,7vw,5.5rem)] leading-[0.98]" style={{ fontWeight: 500, letterSpacing: '-0.025em' }}>
              Time off,<br />
              <span className="italic" style={{ color: 'var(--evergreen-300)' }}>accounted for.</span>
            </h1>
            <p className="text-lg md:text-xl mt-8 max-w-xl opacity-80" style={{ fontWeight: 300, lineHeight: 1.5 }}>
              A deliberate, elegant HR platform built for Saudi businesses. Service-based entitlements, working-day calculations, pro-rated joiners — all computed correctly, every time.
            </p>
            <div className="flex flex-wrap gap-3 mt-10">
              <button onClick={onEnter}
                className="flex items-center gap-2 px-6 py-3.5 rounded-full text-base transition-all hover:translate-x-0.5"
                style={{ background: '#F4EEDF', color: 'var(--evergreen-900)', fontWeight: 500 }}>
                Enter the platform <ArrowRight className="w-4 h-4" />
              </button>
              <a href="#features"
                className="flex items-center gap-2 px-6 py-3.5 rounded-full text-base border transition-all hover:bg-white/5"
                style={{ borderColor: 'rgba(244,238,223,0.2)', color: '#F4EEDF' }}>
                How it works
              </a>
            </div>

            {/* Stats strip */}
            <div className="grid grid-cols-3 gap-6 mt-20 pt-8 border-t" style={{ borderColor: 'rgba(244,238,223,0.12)' }}>
              <Stat number="21→30" label="Days by service" />
              <Stat number="9" label="Leave categories" />
              <Stat number="3" label="Office locations" />
            </div>
          </div>
        </div>

        {/* Subtle bottom cut */}
        <svg className="absolute bottom-0 left-0 w-full" viewBox="0 0 1440 60" preserveAspectRatio="none" height="60">
          <path d="M0,60 L0,20 Q 360,0 720,20 T 1440,20 L 1440,60 Z" fill="var(--paper)" />
        </svg>
      </section>

      {/* ───────────── FEATURES ───────────── */}
      <section id="features" className="relative py-24 md:py-32" style={{ background: 'var(--paper)' }}>
        <div className="max-w-7xl mx-auto px-6">
          <div className="max-w-2xl mb-16">
            <div className="flex items-center gap-2 mb-5 text-xs tracking-[0.25em] opacity-60">
              <div className="w-6 h-px" style={{ background: 'var(--evergreen-500)' }} />
              CAPABILITIES
            </div>
            <h2 className="serif text-5xl md:text-6xl leading-[1.02]" style={{ fontWeight: 500, letterSpacing: '-0.02em' }}>
              Built the way<br /><span className="italic" style={{ color: 'var(--evergreen-500)' }}>KSA HR</span> actually works.
            </h2>
            <p className="mt-6 text-lg opacity-70" style={{ fontWeight: 300 }}>
              Not a generic leave tracker dressed up in local colours. Every rule, every calculation, every edge case modelled from the ground up for Saudi labor law.
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
            <Feature
              icon={CalendarDays}
              title="Working-day counting"
              body="Leaves exclude Fridays, Saturdays, and Saudi public holidays. Sick and maternity use calendar days, as required by statute."
            />
            <Feature
              icon={Clock}
              title="Service-based entitlement"
              body="21 days for employees under five years of service, 30 after. Calculated automatically from each person's join date."
            />
            <Feature
              icon={Compass}
              title="Pro-rated for joiners"
              body="Someone who joins mid-year only earns what they've accrued. No awkward conversations about borrowed days."
            />
            <Feature
              icon={ShieldCheck}
              title="Eligibility rules"
              body="Hajj leave requires two years service. Maternity is gender-gated. Rules are codified, not left to chance."
            />
            <Feature
              icon={Users}
              title="Overlap detection"
              body="Two leaves on the same person? The system flags it before approval. No double-booked absences."
            />
            <Feature
              icon={Leaf}
              title="Live, cloud-native"
              body="Backed by Supabase. Your team sees the same data in real time, from any office. No spreadsheets, no email chains."
            />
          </div>
        </div>
      </section>

      {/* ───────────── SAUDI LAW STRIP ───────────── */}
      <section id="law" className="py-24 md:py-32 relative overflow-hidden" style={{ background: 'var(--evergreen-50)' }}>
        <div className="max-w-7xl mx-auto px-6 grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <div className="flex items-center gap-2 mb-5 text-xs tracking-[0.25em] opacity-60">
              <div className="w-6 h-px" style={{ background: 'var(--evergreen-500)' }} />
              SAUDI LABOR LAW
            </div>
            <h2 className="serif text-4xl md:text-5xl leading-[1.05] mb-6" style={{ fontWeight: 500, letterSpacing: '-0.02em' }}>
              Compliance,<br />by default.
            </h2>
            <p className="text-lg opacity-75 mb-8" style={{ fontWeight: 300 }}>
              The nine leave categories come pre-configured with the statutory defaults from the Saudi Labor Law. Adjust any category to match your company policy — the system will never silently under-accrue.
            </p>
            <ul className="space-y-3">
              {[
                'Annual leave ladders from 21 to 30 days at the five-year mark',
                'Sick leave: 30 full pay → 60 at three-quarters → 30 unpaid',
                'Hajj leave gated by two-year service minimum',
                'Maternity 10-week allowance with attachment requirement',
                'Friday–Saturday weekend and KSA public holidays excluded',
              ].map((t, i) => (
                <li key={i} className="flex items-start gap-3">
                  <Check className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: 'var(--evergreen-500)' }} />
                  <span className="text-base">{t}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="relative">
            <LawCardStack />
          </div>
        </div>
      </section>

      {/* ───────────── CTA ───────────── */}
      <section className="py-24 md:py-32 relative" style={{ background: 'var(--paper)' }}>
        <div className="max-w-4xl mx-auto px-6 text-center">
          <h2 className="serif text-5xl md:text-6xl leading-[1.02]" style={{ fontWeight: 500, letterSpacing: '-0.02em' }}>
            Start with a<br />
            <span className="italic" style={{ color: 'var(--evergreen-500)' }}>quiet afternoon.</span>
          </h2>
          <p className="text-lg opacity-70 mt-6 max-w-xl mx-auto" style={{ fontWeight: 300 }}>
            Sign in, run the connectivity check, and your roster appears. Takes less than a minute.
          </p>
          <button onClick={onEnter}
            className="inline-flex items-center gap-2 mt-10 px-7 py-4 rounded-full text-base transition-all hover:translate-x-0.5"
            style={{ background: 'var(--evergreen-900)', color: '#F4EEDF', fontWeight: 500 }}>
            Enter Leave Desk <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </section>

      {/* ───────────── FOOTER ───────────── */}
      <footer className="border-t py-10" style={{ borderColor: 'var(--border-soft)', background: 'var(--paper-2)' }}>
        <div className="max-w-7xl mx-auto px-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3 opacity-70">
            <EvergreenLogo variant="mark" size="sm" />
            <span className="text-sm">Leave Desk · HR Platform</span>
          </div>
          <div className="text-xs opacity-50 tracking-wide">
            Powered by Supabase · Deployed on Netlify
          </div>
        </div>
      </footer>
    </div>
  );
}

/* ──────────── evergreen flowing line background ──────────── */
function EvergreenLines() {
  return (
    <svg className="absolute inset-0 w-full h-full pointer-events-none" preserveAspectRatio="none" viewBox="0 0 1440 900">
      <defs>
        <linearGradient id="lineGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#8FB39A" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#BFD5C4" stopOpacity="0.05" />
        </linearGradient>
      </defs>
      {/* Three flowing lines drawn in on load */}
      <path className="draw-line"   d="M -100,650 C 300,480 500,780 900,560 S 1300,500 1540,640"
            fill="none" stroke="url(#lineGrad)" strokeWidth="1"/>
      <path className="draw-line draw-line-2" d="M -100,720 C 280,600 520,820 920,640 S 1320,600 1540,720"
            fill="none" stroke="url(#lineGrad)" strokeWidth="1" opacity="0.6"/>
      <path className="draw-line draw-line-3" d="M -100,780 C 280,700 520,870 920,720 S 1320,700 1540,800"
            fill="none" stroke="url(#lineGrad)" strokeWidth="1" opacity="0.35"/>
      {/* Subtle ornament dots on lines */}
      <circle cx="400" cy="580" r="2.5" fill="#BFD5C4" className="pulse-dot" />
      <circle cx="900" cy="560" r="2.5" fill="#8FB39A" className="pulse-dot" style={{ animationDelay: '0.8s' }} />
      <circle cx="1200" cy="600" r="2.5" fill="#BFD5C4" className="pulse-dot" style={{ animationDelay: '1.4s' }} />
    </svg>
  );
}

function LeafMark({ small }) {
  const s = small ? 18 : 22;
  return (
    <svg width={s} height={s} viewBox="0 0 32 32">
      <path d="M16 5 C 9 10, 9 20, 16 27 C 23 20, 23 10, 16 5 Z"
            fill="none" stroke="#8FB39A" strokeWidth="1.5" strokeLinejoin="round"/>
      <line x1="16" y1="5" x2="16" y2="27" stroke="#8FB39A" strokeWidth="1.3"/>
    </svg>
  );
}

function Stat({ number, label }) {
  return (
    <div>
      <div className="serif text-3xl md:text-4xl leading-none" style={{ fontWeight: 500, color: 'var(--evergreen-300)' }}>{number}</div>
      <div className="text-xs mt-2 opacity-60 tracking-wider uppercase">{label}</div>
    </div>
  );
}

function Feature({ icon: Icon, title, body }) {
  return (
    <div className="group relative p-7 rounded-xl border transition-all hover:shadow-lg"
         style={{ borderColor: 'var(--border-soft)', background: '#FFFDF7' }}>
      <div className="w-10 h-10 rounded-lg flex items-center justify-center mb-5"
           style={{ background: 'var(--evergreen-50)', color: 'var(--evergreen-500)' }}>
        <Icon className="w-5 h-5" />
      </div>
      <h3 className="serif text-xl leading-tight mb-2" style={{ fontWeight: 500 }}>{title}</h3>
      <p className="text-sm opacity-70 leading-relaxed">{body}</p>
      {/* Corner accent line */}
      <svg className="absolute top-0 right-0 opacity-20" width="60" height="60" viewBox="0 0 60 60">
        <path d="M 0 10 Q 20 10, 30 20 Q 40 30, 50 30 L 60 30" fill="none" stroke="var(--evergreen-500)" strokeWidth="0.7" />
      </svg>
    </div>
  );
}

function LawCardStack() {
  const items = [
    { label: 'Annual · < 5 yrs', value: '21 days', color: '#2D5F3F' },
    { label: 'Annual · 5+ yrs',  value: '30 days', color: '#1F4A2F' },
    { label: 'Sick · full pay',  value: '30 days', color: '#B84A3E' },
    { label: 'Hajj',             value: '15 days', color: '#8B6B3E' },
    { label: 'Maternity',        value: '10 weeks', color: '#C97B84' },
    { label: 'Paternity',        value: '3 days',  color: '#5A7A9B' },
  ];
  return (
    <div className="grid grid-cols-2 gap-3">
      {items.map((item, i) => (
        <div key={i}
          className="p-5 rounded-xl border sway"
          style={{
            borderColor: 'var(--border-soft)',
            background: '#FFFDF7',
            animationDelay: `${i * 0.2}s`,
          }}>
          <div className="flex items-center gap-2 mb-3">
            <div className="w-2 h-2 rounded-full" style={{ background: item.color }}/>
            <div className="text-xs opacity-60 tracking-wider">{item.label.toUpperCase()}</div>
          </div>
          <div className="serif text-2xl" style={{ fontWeight: 500, color: item.color }}>{item.value}</div>
        </div>
      ))}
    </div>
  );
}
