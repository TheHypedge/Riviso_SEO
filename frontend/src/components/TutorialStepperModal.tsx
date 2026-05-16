"use client";

import { useCallback, useEffect, useState } from "react";

import {
  RIVISO_TUTORIAL_INTRO,
  RIVISO_TUTORIAL_STEPS,
  type RivisoTutorialStep,
} from "@/content/rivisoTutorial";

import styles from "./TutorialStepperModal.module.css";

type Props = {
  onClose: () => void;
  steps?: RivisoTutorialStep[];
};

function StepImage({ step }: { step: RivisoTutorialStep }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const src = (step.imageSrc || "").trim();

  if (!src || failed) {
    return (
      <div className={styles.imagePlaceholder}>
        <span className={styles.imagePlaceholderTitle}>Screenshot</span>
        <span className={styles.imagePlaceholderHint}>
          Add <code>{src || `/tutorial/step-${step.stepNumber}-${step.id}.png`}</code>
        </span>
      </div>
    );
  }

  const encoded = encodeURI(src);

  return (
    <div className={styles.imageWrap}>
      {!loaded ? <div className={styles.imageSkeleton} aria-hidden="true" /> : null}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className={`${styles.image} ${loaded ? styles.imageLoaded : ""}`}
        src={encoded}
        alt={step.imageAlt || step.title}
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

export function TutorialStepperModal({ onClose, steps = RIVISO_TUTORIAL_STEPS }: Props) {
  const [index, setIndex] = useState(0);

  const total = steps.length;
  const step = steps[index];
  const isFirst = index === 0;
  const isLast = index >= total - 1;

  const close = useCallback(() => {
    onClose();
    setIndex(0);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  if (!step) return null;

  return (
    <>
      <button type="button" className={styles.backdrop} aria-label="Close tutorial" onClick={close} />
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="riviso-tutorial-title"
        aria-describedby="riviso-tutorial-body"
      >
        <header className={styles.head}>
          <div className={styles.headText}>
            <p className={styles.kicker}>Getting started</p>
            <h2 id="riviso-tutorial-title" className={styles.title}>
              Riviso tutorial
            </h2>
            <p className={styles.intro}>{RIVISO_TUTORIAL_INTRO}</p>
          </div>
          <button type="button" className={styles.closeBtn} aria-label="Close" onClick={close}>
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className={styles.progress} aria-label="Tutorial progress">
          {steps.map((s, i) => (
            <button
              key={s.id}
              type="button"
              className={`${styles.progressStep} ${i === index ? styles.progressStepActive : ""} ${i < index ? styles.progressStepDone : ""}`}
              aria-label={`Step ${s.stepNumber}: ${s.title}`}
              aria-current={i === index ? "step" : undefined}
              onClick={() => setIndex(i)}
            >
              <span className={styles.progressStepNum}>{s.stepNumber}</span>
              <span className={styles.progressStepLabel}>{s.title}</span>
            </button>
          ))}
        </div>

        <div className={styles.body}>
          <div className={styles.stepCopy}>
            <p className={styles.stepBadge}>
              Step {step.stepNumber} of {total}
            </p>
            <h3 className={styles.stepTitle}>{step.title}</h3>
            <p id="riviso-tutorial-body" className={styles.stepBody}>
              {step.body}
            </p>
          </div>

          <figure className={styles.imageFrame} aria-label={`Screenshot: ${step.title}`}>
            <StepImage key={`${step.id}-${step.imageSrc || ""}`} step={step} />
          </figure>
        </div>

        <footer className={styles.footer}>
          <span className={styles.stepCounter}>
            {step.stepNumber} / {total}
          </span>
          <div className={styles.footerActions}>
            <button
              type="button"
              className={styles.btnSecondary}
              disabled={isFirst}
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
            >
              Back
            </button>
            {isLast ? (
              <button type="button" className={styles.btnPrimary} onClick={close}>
                Finish
              </button>
            ) : (
              <button
                type="button"
                className={styles.btnPrimary}
                onClick={() => setIndex((i) => Math.min(total - 1, i + 1))}
              >
                Next
              </button>
            )}
          </div>
        </footer>
      </div>
    </>
  );
}
