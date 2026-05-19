"use client";

import {
  Children,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import carouselStyles from "./OverviewStatCarousel.module.css";

const MOBILE_MQ = "(max-width: 720px)";
const TRACK_GAP_PX = 12;

/**
 * Wraps overview stat cards: grid on desktop; on mobile shows ~2 cards plus a peek
 * of the next, with swipe scroll and pagination dots.
 */
export function OverviewStatCarousel(props: {
  trackClassName: string;
  children: ReactNode;
  ariaLabel?: string;
}) {
  const { trackClassName, children, ariaLabel = "Overview statistics" } = props;
  const trackRef = useRef<HTMLDivElement>(null);
  const childCount = Children.count(children);
  const pageCount = Math.max(1, Math.ceil(childCount / 2));

  const [activePage, setActivePage] = useState(0);
  const [mobileCarousel, setMobileCarousel] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_MQ);
    const sync = () => setMobileCarousel(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const cardStride = useCallback(() => {
    const el = trackRef.current;
    const card = el?.firstElementChild as HTMLElement | null;
    if (!card) return 0;
    return card.offsetWidth + TRACK_GAP_PX;
  }, []);

  const updatePage = useCallback(() => {
    const el = trackRef.current;
    if (!el || !mobileCarousel) return;
    const stride = cardStride();
    if (stride <= 0) return;
    const cardIndex = Math.round(el.scrollLeft / stride);
    const page = Math.min(pageCount - 1, Math.max(0, Math.floor(cardIndex / 2)));
    setActivePage(page);
  }, [cardStride, mobileCarousel, pageCount]);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    updatePage();
    el.addEventListener("scroll", updatePage, { passive: true });
    const ro = new ResizeObserver(updatePage);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", updatePage);
      ro.disconnect();
    };
  }, [updatePage, children]);

  const goToPage = (page: number) => {
    const el = trackRef.current;
    const stride = cardStride();
    if (!el || stride <= 0) return;
    el.scrollTo({ left: page * 2 * stride, behavior: "smooth" });
    setActivePage(page);
  };

  const showDots = mobileCarousel && pageCount > 1;

  return (
    <div className={carouselStyles.shell}>
      <div
        ref={trackRef}
        className={`${trackClassName} ${carouselStyles.track}`}
        role="list"
        aria-label={ariaLabel}
      >
        {children}
      </div>
      {showDots ? (
        <div className={carouselStyles.dots} role="tablist" aria-label={`${ariaLabel} pages`}>
          {Array.from({ length: pageCount }, (_, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === activePage}
              aria-label={`Show statistics ${i * 2 + 1}–${Math.min(i * 2 + 2, childCount)} of ${childCount}`}
              className={`${carouselStyles.dot} ${i === activePage ? carouselStyles.dotActive : ""}`}
              onClick={() => goToPage(i)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
