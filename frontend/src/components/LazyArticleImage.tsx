"use client";

import { useEffect, useState } from "react";

import styles from "@/app/page.module.css";

type LazyArticleImageProps = {
  src: string;
  alt: string;
  className?: string;
};

/**
 * Featured / preview image with native lazy loading and a skeleton until decoded.
 */
export function LazyArticleImage({ src, alt, className }: LazyArticleImageProps) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [src]);

  return (
    <div className={styles.articleImageLazyWrap} data-loaded={loaded ? "true" : "false"}>
      {!loaded && !failed ? <div className={styles.articleImageSkeleton} aria-hidden="true" /> : null}
      {failed ? (
        <div className={styles.articleImageSkeleton} style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span className={styles.muted} style={{ fontSize: 12 }}>
            Image failed to load
          </span>
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          className={className}
          loading="lazy"
          decoding="async"
          fetchPriority="low"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          style={{
            opacity: loaded ? 1 : 0,
            transition: "opacity 0.25s ease",
          }}
        />
      )}
    </div>
  );
}
