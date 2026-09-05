-- cosmos:statement
-- Revocation retains the installation locator's original owner and surface.
CREATE UNIQUE INDEX IF NOT EXISTS cosmos_native_enrollment_unique
    ON cosmos_surface_registry ((record #>> '{binding,enrollment_id}'))
    WHERE record #>> '{binding,profile}' = 'native';
