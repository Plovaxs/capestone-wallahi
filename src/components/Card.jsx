import React from 'react';

// 🟩 DESIGN SYSTEM: the "white rounded-2xl shadow-sm border" card shell is
// copy-pasted across every view's JSX today. This is the canonical version
// for new UI so it isn't re-typed (and subtly drifted) again.
const Card = ({ className = '', children, ...rest }) => (
  <div
    className={`bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 ${className}`}
    {...rest}
  >
    {children}
  </div>
);

export default Card;
