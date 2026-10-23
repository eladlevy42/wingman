# React Router DOM for client-side routing

We chose `react-router-dom` v7 as the routing library for the web app. The alternative was TanStack Router, which is now the recommended default for Vite + React and offers fully type-safe routes. We picked React Router because the team is already familiar with it, the POC has only a handful of routes, and the type-safety gains of TanStack Router aren't worth the learning curve at this stage. If the app grows significantly, revisit this — TanStack Router's type inference becomes valuable at scale.
