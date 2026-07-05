// Settings context or provider should include timeFormatSeconds
import React from 'react';

const defaultSettings = {
  timeFormat: '24',
  timeFormatSeconds: false
};

export const SettingsContext = React.createContext(defaultSettings);

export function useSettings() {
  return React.useContext(SettingsContext);
}

// ... provider component that merges server settings ...