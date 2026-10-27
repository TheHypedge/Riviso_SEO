"use client";

import { useMemo, useState } from "react";

import { Hint } from "@/components/settings/Hint";
import { TagSelect, type TagOption } from "@/components/TagSelect";
import { AUDIENCE_PRESETS, BRAND_TONES, BRAND_VOICES, citiesForCountry } from "@/lib/brand_dictionaries";
import { COUNTRIES } from "@/lib/countries";

import s from "./settingsCard.module.css";

const MAX_TONES = 5;
const RULES_MAX = 4000;
const COUNTRY_OPTIONS: TagOption[] = COUNTRIES.map((c) => ({ value: c.code, label: c.name }));
const TONE_OPTIONS: TagOption[] = BRAND_TONES.map((t) => ({ value: t.label, label: t.label }));
const AUDIENCE_OPTIONS: TagOption[] = AUDIENCE_PRESETS.map((a) => ({ value: a.label, label: a.label }));
const countryName = (code: string) => COUNTRIES.find((c) => c.code === code)?.name ?? code;

type Props = {
  voice: string;
  onVoice: (v: string) => void;
  tones: string[];
  onTones: (v: string[]) => void;
  rules: string;
  onRules: (v: string) => void;
  niche: string;
  onNiche: (v: string) => void;
  audience: string[];
  onAudience: (v: string[]) => void;
  countries: string[];
  onCountries: (v: string[]) => void;
  countriesAll: boolean;
  onCountriesAll: (v: boolean) => void;
  cities: string[];
  onCities: (v: string[]) => void;
  citiesAll: boolean;
  onCitiesAll: (v: boolean) => void;
};

/** Project Settings → Content & targeting: how the AI writes, about what, for whom and where. */
export function ContentTargetingSection(p: Props) {
  // Local targeting stays open while any city setting exists; otherwise it's opt-in.
  const [localOpen, setLocalOpen] = useState(p.cities.length > 0 || p.citiesAll);
  const localOn = !p.countriesAll && p.countries.length > 0 && (localOpen || p.cities.length > 0 || p.citiesAll);

  const cityOptions = useMemo<TagOption[]>(
    () => {
      // A city name can exist in two target countries (e.g. Hyderabad) -- list it once.
      const seen = new Set<string>();
      return p.countries.flatMap((code) =>
        citiesForCountry(code)
          .filter((city) => !seen.has(city) && seen.add(city))
          .map((city) => ({ value: city, label: city, hint: countryName(code) })),
      );
    },
    [p.countries],
  );

  function setCountries(next: string[]) {
    // Cities that belonged only to a removed country go with it; custom cities stay.
    const removed = p.countries.filter((c) => !next.includes(c));
    if (removed.length) {
      const dropped = new Set(removed.flatMap((c) => citiesForCountry(c)));
      const kept = new Set(next.flatMap((c) => citiesForCountry(c)));
      p.onCities(p.cities.filter((city) => !dropped.has(city) || kept.has(city)));
    }
    p.onCountries(next);
  }

  function setWorldwide(on: boolean) {
    p.onCountriesAll(on);
    if (on) {
      p.onCountries([]);
      p.onCities([]);
      p.onCitiesAll(false);
    }
  }

  function setLocal(on: boolean) {
    setLocalOpen(on);
    if (!on) {
      p.onCities([]);
      p.onCitiesAll(false);
    }
  }

  return (
    <div className={s.stack}>
      <section className={s.card} aria-labelledby="ct-voice-title">
        <header className={s.headCompact}>
          <div className={s.titleRow}>
            <h3 id="ct-voice-title" className={s.title}>
              Brand voice
            </h3>
            <Hint label="About brand voice">
              How the AI writes for this project. Voice, tones and rules go into every article
              prompt. Only the voice also sets the mood of generated images.
            </Hint>
          </div>
          <p className={s.subtitle}>How every article should sound.</p>
        </header>

        <div className={s.gridWide}>
          <label className={s.field}>
            <span className={s.label}>Voice</span>
            <select className={s.input} value={p.voice} onChange={(e) => p.onVoice(e.target.value)}>
              <option value="">Choose a voice…</option>
              {BRAND_VOICES.map((v) => (
                <option key={v.id} value={v.label}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <div className={s.field}>
            <span className={s.label}>Tones</span>
            <TagSelect
              options={TONE_OPTIONS}
              value={p.tones}
              onChange={p.onTones}
              max={MAX_TONES}
              ariaLabel="Tones"
              placeholder="Search tones, e.g. Direct, Empathetic…"
            />
          </div>
        </div>

        <label className={s.field} style={{ marginTop: 12 }}>
          <span className={s.labelRow}>
            <span className={s.label}>Writing rules</span>
            <span className={s.counter}>
              {p.rules.length}/{RULES_MAX}
            </span>
          </span>
          <textarea
            className={s.textarea}
            value={p.rules}
            onChange={(e) => p.onRules(e.target.value.slice(0, RULES_MAX))}
            rows={3}
            placeholder={"One rule per line, e.g.\nAvoid buzzwords like “game-changer”.\nCite a source for every statistic."}
          />
        </label>
      </section>

      <section className={s.card} aria-labelledby="ct-niche-title">
        <header className={s.headCompact}>
          <div className={s.titleRow}>
            <h3 id="ct-niche-title" className={s.title}>
              Niche &amp; audience
            </h3>
            <Hint label="About niche and audience">
              What the articles are about and who reads them. The niche also guides image
              generation; the audience only shapes the writing.
            </Hint>
          </div>
          <p className={s.subtitle}>What you write about, and for whom.</p>
        </header>

        <div className={s.grid}>
          <label className={s.field}>
            <span className={s.label}>Niche</span>
            <input
              className={s.input}
              value={p.niche}
              onChange={(e) => p.onNiche(e.target.value.slice(0, 500))}
              placeholder="e.g. Mutual divorce advocacy in India"
            />
          </label>
          <div className={s.field}>
            <span className={s.label}>Audience</span>
            <TagSelect
              options={AUDIENCE_OPTIONS}
              value={p.audience}
              onChange={p.onAudience}
              allowCustom
              ariaLabel="Audience"
              placeholder="Search or type your own…"
            />
          </div>
        </div>
      </section>

      <section className={s.card} aria-labelledby="ct-market-title">
        <header className={s.headCompact}>
          <div className={s.titleRow}>
            <h3 id="ct-market-title" className={s.title}>
              Target market
            </h3>
            <Hint label="About target market">
              Countries steer examples, laws, currency and spelling in articles. The first
              country is also the default for Research and Topic Clusters. Not sent to image
              generation.
            </Hint>
          </div>
          <p className={s.subtitle}>Where your readers are.</p>
        </header>

        <div className={s.field}>
          <span className={s.labelRow}>
            <span className={s.label}>Countries</span>
            <label className={s.inlineToggle}>
              <input
                type="checkbox"
                role="switch"
                className={s.switchSm}
                checked={p.countriesAll}
                onChange={(e) => setWorldwide(e.target.checked)}
              />
              Worldwide
            </label>
          </span>
          {p.countriesAll ? (
            <div className={s.note}>Articles are written for a global audience.</div>
          ) : (
            <TagSelect
              options={COUNTRY_OPTIONS}
              value={p.countries}
              onChange={setCountries}
              ariaLabel="Countries"
              placeholder="Search countries…"
            />
          )}
        </div>

        {!p.countriesAll ? (
          <div className={s.optionRow}>
            <div className={s.optionText}>
              <span className={s.optionTitle} id="ct-local-label">
                Local targeting
              </span>
              <span className={s.optionDesc}>
                {p.countries.length
                  ? "Name specific cities — useful for local services like clinics, lawyers or stores."
                  : "Add a country first to target its cities."}
              </span>
            </div>
            <input
              type="checkbox"
              role="switch"
              className={s.switch}
              aria-labelledby="ct-local-label"
              checked={localOn}
              disabled={!p.countries.length}
              onChange={(e) => setLocal(e.target.checked)}
            />
          </div>
        ) : null}

        {localOn ? (
          <div className={s.field} style={{ marginTop: 12 }}>
            <span className={s.labelRow}>
              <span className={s.label}>Cities</span>
              <label className={s.inlineToggle}>
                <input
                  type="checkbox"
                  className={s.checkbox}
                  checked={p.citiesAll}
                  onChange={(e) => {
                    p.onCitiesAll(e.target.checked);
                    if (e.target.checked) p.onCities([]);
                  }}
                />
                All major cities
              </label>
            </span>
            {p.citiesAll ? (
              <div className={s.note}>Articles reference major cities across your target countries.</div>
            ) : (
              <TagSelect
                options={cityOptions}
                value={p.cities}
                onChange={p.onCities}
                allowCustom
                ariaLabel="Cities"
                placeholder="Search or type a city…"
              />
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}
