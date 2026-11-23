import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { SITE_ROUTES } from './config/facility';
import { HomePage } from './pages/HomePage';
import {
  AboutPage,
  ContactPage,
  PrivacyPolicyPage,
  RatesPage,
  TermsPolicyPage,
} from './pages/FacilityPages';
import {
  AdminDashboardPlaceholderPage,
  AdminLoginPage,
  AvailabilityPage,
  BookCourtPage,
  ConfirmationPage,
  LookupPage,
} from './pages/BookingFlowPages';

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path={SITE_ROUTES.home} element={<HomePage />} />
          <Route path={SITE_ROUTES.book} element={<BookCourtPage />} />
          <Route path={SITE_ROUTES.availability} element={<AvailabilityPage />} />
          <Route path={SITE_ROUTES.rates} element={<RatesPage />} />
          <Route path={SITE_ROUTES.about} element={<AboutPage />} />
          <Route path={SITE_ROUTES.contact} element={<ContactPage />} />
          <Route path={SITE_ROUTES.confirmation} element={<ConfirmationPage />} />
          <Route path={`${SITE_ROUTES.confirmation}/:reference`} element={<ConfirmationPage />} />
          <Route path={SITE_ROUTES.lookup} element={<LookupPage />} />
          <Route path={SITE_ROUTES.privacy} element={<PrivacyPolicyPage />} />
          <Route path={SITE_ROUTES.terms} element={<TermsPolicyPage />} />
          <Route path={SITE_ROUTES.adminLogin} element={<AdminLoginPage />} />
          <Route path={SITE_ROUTES.adminDashboard} element={<AdminDashboardPlaceholderPage />} />
          <Route path="*" element={<Navigate to={SITE_ROUTES.home} replace />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
