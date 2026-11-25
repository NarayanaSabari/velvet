import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

// First on purpose: index.css declares the cascade-layer order that the
// Astryx and theme stylesheets below depend on.
import './index.css'
import { LinkProvider } from '@astryxdesign/core/Link'
import { Theme } from '@astryxdesign/core/theme'
import { AppLink } from './app/AppLink'
import { LOOKS, currentLook } from './app/astryxTheme'
import { queryClient } from './lib/query'
import { router } from './routes/router'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

createRoot(root).render(
  <StrictMode>
    <Theme theme={LOOKS[currentLook()]}>
      <LinkProvider component={AppLink}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </LinkProvider>
    </Theme>
  </StrictMode>,
)
