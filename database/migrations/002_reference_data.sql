-- 002_reference_data: permissions, roles, default platform settings (reference data, not demo data).
INSERT INTO permissions(key, description) VALUES
 ('booking:create','Create bookings as a passenger'),
 ('driver:apply','Apply for driver verification'),
 ('vehicle:manage','Manage own vehicles'),
 ('trip:publish','Publish trips'),
 ('users:read','Read user accounts (admin)'),
 ('users:suspend','Suspend user accounts'),
 ('users:reinstate','Reinstate user accounts'),
 ('roles:assign','Assign roles to users'),
 ('verification:review','Approve/reject driver and vehicle verification'),
 ('bookings:read:any','Read any booking'),
 ('trips:read:any','Read any trip incl. non-public data'),
 ('trips:cancel:any','Cancel any trip'),
 ('audit:read','Read audit logs'),
 ('settings:write','Change platform settings'),
 ('finance:read','Read financial reports'),
 ('finance:refund','Issue refunds'),
 ('support:read','Read support tickets');

INSERT INTO roles(key, description) VALUES
 ('passenger','Registered passenger'),
 ('driver','Driver (verification may be pending)'),
 ('verified_driver','Driver approved to publish trips'),
 ('support_agent','Customer support agent'),
 ('verification_reviewer','Verification reviewer'),
 ('finance_operator','Finance operator'),
 ('administrator','Administrator'),
 ('super_administrator','Super administrator');

INSERT INTO role_permissions(role_key, permission_key) VALUES
 ('passenger','booking:create'),
 ('driver','driver:apply'), ('driver','vehicle:manage'),
 ('verified_driver','driver:apply'), ('verified_driver','vehicle:manage'), ('verified_driver','trip:publish'),
 ('support_agent','users:read'), ('support_agent','bookings:read:any'), ('support_agent','trips:read:any'), ('support_agent','support:read'),
 ('verification_reviewer','verification:review'),
 ('finance_operator','finance:read'), ('finance_operator','finance:refund'),
 ('administrator','users:read'), ('administrator','users:suspend'), ('administrator','users:reinstate'),
 ('administrator','bookings:read:any'), ('administrator','trips:read:any'), ('administrator','trips:cancel:any'),
 ('administrator','audit:read'), ('administrator','settings:write'),
 ('super_administrator','users:read'), ('super_administrator','users:suspend'), ('super_administrator','users:reinstate'),
 ('super_administrator','roles:assign'), ('super_administrator','verification:review'),
 ('super_administrator','bookings:read:any'), ('super_administrator','trips:read:any'), ('super_administrator','trips:cancel:any'),
 ('super_administrator','audit:read'), ('super_administrator','settings:write'),
 ('super_administrator','finance:read'), ('super_administrator','finance:refund'), ('super_administrator','support:read');

-- Operational restrictions: everything legally sensitive is OFF until approvals exist.
INSERT INTO platform_settings(key, value) VALUES
 ('trip_publishing_enabled','false'),
 ('booking_enabled','false'),
 ('payments_enabled','false'),
 ('require_driver_approval','true'),
 ('booking_approval_timeout_minutes','720'),
 ('payment_hold_minutes','15'),
 ('max_segment_price_minor','500000'),
 ('min_booking_lead_minutes','30');
