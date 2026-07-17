-- Migration: 0059_spider_trap_seed_addresses.sql
-- Spider trap seed addresses on public pages + honeypot directory pages

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, seeded_location, status) VALUES
-- Public page hidden div traps
('sp.trap01@averrow.com','averrow.com','generic','spider:public_pages','active'),
('sp.trap02@trustradar.ca','trustradar.ca','generic','spider:public_pages','active'),
('sp.trap03@averrow.com','averrow.com','generic','spider:public_pages','active'),
('sp.trap04@trustradar.ca','trustradar.ca','generic','spider:public_pages','active'),
('sp.trap05@averrow.com','averrow.com','generic','spider:public_pages','active'),
('sp.trap06@averrow.com','averrow.com','generic','spider:public_pages','active'),
('sp.trap07@trustradar.ca','trustradar.ca','generic','spider:public_pages','active'),
('sp.trap08@averrow.com','averrow.com','generic','spider:public_pages','active'),
-- HTML comment traps
('sp.trap09@trustradar.ca','trustradar.ca','generic','spider:html_comment','active'),
('sp.trap10@averrow.com','averrow.com','generic','spider:html_comment','active'),
-- Team page (honeypot directory) traps
('james.wilson.t01@averrow.com','averrow.com','directory','spider:team_page','active'),
('sarah.chen.t02@trustradar.ca','trustradar.ca','directory','spider:team_page','active'),
('michael.brown.t03@averrow.com','averrow.com','directory','spider:team_page','active'),
('emily.davis.t04@trustradar.ca','trustradar.ca','directory','spider:team_page','active'),
('david.lee.t05@averrow.com','averrow.com','directory','spider:team_page','active'),
-- Admin portal honeypot traps
('robert.taylor.hp01@averrow.com','averrow.com','directory','spider:admin_portal','active'),
('lisa.martinez.hp02@trustradar.ca','trustradar.ca','directory','spider:admin_portal','active'),
('kevin.park.hp03@averrow.com','averrow.com','directory','spider:admin_portal','active'),
-- Internal staff honeypot traps
('amanda.white.hp04@trustradar.ca','trustradar.ca','directory','spider:internal_staff','active'),
('chris.johnson.hp05@averrow.com','averrow.com','directory','spider:internal_staff','active'),
('rachel.kim.hp06@trustradar.ca','trustradar.ca','directory','spider:internal_staff','active'),
('tom.harris.hp07@averrow.com','averrow.com','directory','spider:internal_staff','active');
