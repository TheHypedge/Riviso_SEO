/**
 * Riviso onboarding tutorial steps.
 *
 * Add screenshots under ``frontend/public/tutorial/`` and set ``imageSrc``
 * (e.g. ``/tutorial/step-1-register.png``). Spaces in filenames are OK.
 */

export type RivisoTutorialStep = {
  id: string;
  stepNumber: number;
  title: string;
  body: string;
  /** Public URL path, e.g. `/tutorial/step-1-register.png` */
  imageSrc?: string;
  imageAlt?: string;
};

export const RIVISO_TUTORIAL_INTRO =
  "Get your account, WordPress site, and first project ready in four steps.";

export const RIVISO_TUTORIAL_STEPS: RivisoTutorialStep[] = [
  {
    id: "register",
    stepNumber: 1,
    title: "Register your account",
    body: "Sign up with your name and email. Your profile timezone and plan limits are set from here.",
    imageSrc: "/tutorial/Register Account.png",
    imageAlt: "Riviso registration screen",
  },
  {
    id: "add-project",
    stepNumber: 2,
    title: "Add your project",
    body: "From the dashboard, click Add project, name your site, and open it for articles, research, and scheduling.",
    imageSrc: "/tutorial/Add Project.png",
    imageAlt: "Adding a project on the dashboard",
  },
  {
    id: "connect-website",
    stepNumber: 3,
    title: "Connect your website",
    body: "In Project Settings, add your WordPress username and an Application Password, then verify the connection.",
    imageSrc: "/tutorial/Connect Website.png",
    imageAlt: "WordPress connection in Riviso",
  },
  {
    id: "operations",
    stepNumber: 4,
    title: "Run your workflow",
    body: "Use Research, bulk import, scheduling, and export to plan, generate, and publish SEO content end to end.",
    imageSrc: "/tutorial/Operations.png",
    imageAlt: "Riviso project operations modules",
  },
];
