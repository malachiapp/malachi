/**
 * @format
 */

import 'react-native';
import React from 'react';
import App from '../App';

// Note: import explicitly to use the types shipped with jest.
import {it} from '@jest/globals';

// Note: test renderer must be required after react-native.
import renderer from 'react-test-renderer';

it('renders correctly', () => {
  // unmount() raeumt App.tsx's Poll-Intervalle/Effekte sauber ab - ohne das
  // laufen sie nach Testende weiter und greifen auf native Module zu, die
  // Jest laengst abgebaut hat ("Jest environment has been torn down"),
  // sichtbar als (in diesem Fall nicht test-schlagendes, aber irrefuehrendes)
  // Konsolen-Rauschen.
  const tree = renderer.create(<App />);
  tree.unmount();
});
