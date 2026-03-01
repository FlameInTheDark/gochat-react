import { Outlet } from 'react-router-dom'
import DmSidebar from '@/components/layout/DmSidebar'

export default function MeLayout() {
  return (
    <>
      <DmSidebar />
      <Outlet />
    </>
  )
}
