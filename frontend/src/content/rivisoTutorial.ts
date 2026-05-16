/**
 * Riviso onboarding tutorial steps.
 *
 * To add a screenshot for a step, place an image under ``frontend/public/tutorial/``
 * and set ``imageSrc`` (e.g. ``/tutorial/step-1-register.png``).
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
  "A quick walkthrough to get your account, website, and first project ready for SEO content operations.";

export const RIVISO_TUTORIAL_STEPS: RivisoTutorialStep[] = [
  {
    id: "register",
    stepNumber: 1,
    title: "Register your account",
    body: "Register your account on Riviso with your name, email, and workspace details so we can personalize scheduling, limits, and your profile timezone.",
    imageSrc: "/tutorial/step-1-register.png",
    imageAlt: "Riviso registration screen",
  },
  {
    id: "connect-website",
    stepNumber: 2,
    title: "Connect your website",
    body: "Connect your WordPress site to Riviso. Enter your WordPress username and an Application Password from Users → Profile → Application Passwords, then verify the connection.",
    imageSrc: "/tutorial/step-2-connect-wordpress.png",
    imageAlt: "WordPress connection in Riviso",
  },
  {
    id: "add-project",
    stepNumber: 3,
    title: "Add your project",
    body: "From the dashboard, click Add project, name your site, and save. Open the project to access articles, research, prompts, and scheduling.",
    imageSrc: "/tutorial/step-3-add-project.png",
    imageAlt: "Adding a project on the dashboard",
  },
  {
    id: "operations",
    stepNumber: 4,
    title: "Operations",
    body: "Inside your project, use Curations, Pillar & Cluster articles, Bulk Import, Schedule, and Export to run your SEO content workflow end to end.",
    imageSrc: "/tutorial/step-4-operations.png",
    imageAlt: "Riviso project operations modules",
  },
];
