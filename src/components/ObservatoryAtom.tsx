import { lazy, Suspense } from 'react';

/**
 * The query observatory as a WebGL scene. three.js is heavy, so the scene
 * loads lazily and shows nothing while it arrives — the artwork is decorative
 * and must never delay the sign-in form.
 */
const ObservatoryAtomScene = lazy(() => import('./observatory-atom-scene'));

export function ObservatoryAtom() {
  return (
    <Suspense fallback={null}>
      <ObservatoryAtomScene />
    </Suspense>
  );
}
