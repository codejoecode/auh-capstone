INSERT INTO products (slug, name, type, description, image_url) VALUES
('auh-brooklyn-2026-03-20', 'Brooklyn Made (Mar 20, 2026)', 'ticket', 'General admission', ''),
('auh-philly-2026-03-22', 'Philadelphia (Mar 22, 2026)', 'ticket', 'General admission', ''),
('auh-shirt-collider', 'Collider Tee', 'merch', 'Soft black tee with Collider art.', ''),
('auh-vinyl-collider', 'Collider Vinyl', 'merch', '12" vinyl record.', '');

INSERT INTO product_variants (product_id, name, price_cents, stock_qty) VALUES
(1, 'GA', 2500, 250),
(2, 'GA', 2000, 200),
(3, 'Small', 2500, 20),
(3, 'Medium', 2500, 20),
(3, 'Large', 2500, 20),
(4, 'Standard', 3000, 10);

INSERT INTO ticket_details (product_id, event_date, venue_name, venue_city, venue_state, ticket_mode, external_url, is_on_sale) VALUES
(1, '2026-03-20 20:00:00', 'Brooklyn Made', 'Brooklyn', 'NY', 'internal', NULL, 1),
(2, '2026-03-22 20:00:00', 'First Unitarian Church', 'Philadelphia', 'PA', 'internal', NULL, 1);
