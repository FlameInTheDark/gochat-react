import { Outlet } from 'react-router-dom'
import DiscoverySidebar from '@/components/layout/DiscoverySidebar'
import { useClientMode } from '@/hooks/useClientMode'

export default function DiscoveryLayout() {
  const isMobile = useClientMode() === 'mobile'

  if (isMobile) {
    return <Outlet />
  }

  return (
    <>
      <DiscoverySidebar />
      <Outlet />
    </>
  )
}
