import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.intro}>
          <h1>Auto Articles</h1>
          <p>
            New stack is running.
            {" "}
            <a href="/api/health">Backend health</a>
            {" · "}
            <a href="/login">Login</a>
            {" · "}
            <a href="/dashboard">Dashboard</a>
          </p>
        </div>
      </main>
    </div>
  );
}
