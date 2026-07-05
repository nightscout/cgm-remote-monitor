// Assuming clock.js renders a clock
import React from 'react';
import { useSettings } from '../settings';

export default function Clock() {
  const settings = useSettings();
  const [time, setTime] = React.useState(new Date());

  React.useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  function formatTime(date) {
    let hours = date.getHours();
    let minutes = date.getMinutes();
    let seconds = date.getSeconds();
    const ampm = hours >= 12 ? 'PM' : 'AM';

    if (settings.timeFormat === '12') {
      hours = hours % 12 || 12;
    }
    let timeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    if (settings.timeFormatSeconds) {
      timeStr += `:${seconds.toString().padStart(2, '0')}`;
    }
    if (settings.timeFormat === '12') {
      timeStr += ` ${ampm}`;
    }
    return timeStr;
  }

  return <span>{formatTime(time)}</span>;
}