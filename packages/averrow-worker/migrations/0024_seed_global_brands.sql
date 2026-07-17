-- Seed high-value global brands for expanded coverage
-- Uses INSERT OR IGNORE to preserve existing records

-- GLOBAL BANKING & FINANCE
INSERT OR IGNORE INTO brands (id, name, canonical_domain, sector, source, threat_count) VALUES
('brand_hsbc', 'HSBC', 'hsbc.com', 'banking', 'manual', 0),
('brand_barclays', 'Barclays', 'barclays.com', 'banking', 'manual', 0),
('brand_lloyds', 'Lloyds', 'lloyds.com', 'banking', 'manual', 0),
('brand_natwest', 'NatWest', 'natwest.com', 'banking', 'manual', 0),
('brand_deutsche_bank', 'Deutsche Bank', 'db.com', 'banking', 'manual', 0),
('brand_bnp_paribas', 'BNP Paribas', 'bnpparibas.com', 'banking', 'manual', 0),
('brand_societe_generale', 'Société Générale', 'societegenerale.com', 'banking', 'manual', 0),
('brand_ubs', 'UBS', 'ubs.com', 'banking', 'manual', 0),
('brand_ing', 'ING', 'ing.com', 'banking', 'manual', 0),
('brand_santander', 'Santander', 'santander.com', 'banking', 'manual', 0),
('brand_bbva', 'BBVA', 'bbva.com', 'banking', 'manual', 0),
('brand_unicredit', 'UniCredit', 'unicredit.eu', 'banking', 'manual', 0),
('brand_nordea', 'Nordea', 'nordea.com', 'banking', 'manual', 0),
('brand_jpmorgan', 'JPMorgan', 'jpmorgan.com', 'banking', 'manual', 0),
('brand_bofa', 'Bank of America', 'bankofamerica.com', 'banking', 'manual', 0),
('brand_wellsfargo', 'Wells Fargo', 'wellsfargo.com', 'banking', 'manual', 0),
('brand_citibank', 'Citibank', 'citi.com', 'banking', 'manual', 0),
('brand_chase', 'Chase', 'chase.com', 'banking', 'manual', 0),
('brand_capital_one', 'Capital One', 'capitalone.com', 'banking', 'manual', 0),
('brand_schwab', 'Charles Schwab', 'schwab.com', 'banking', 'manual', 0),
('brand_fidelity', 'Fidelity', 'fidelity.com', 'banking', 'manual', 0),
('brand_vanguard', 'Vanguard', 'vanguard.com', 'banking', 'manual', 0),
('brand_commbank', 'Commonwealth Bank', 'commbank.com.au', 'banking', 'manual', 0),
('brand_anz', 'ANZ', 'anz.com', 'banking', 'manual', 0),
('brand_westpac', 'Westpac', 'westpac.com.au', 'banking', 'manual', 0),
('brand_nab', 'NAB', 'nab.com.au', 'banking', 'manual', 0),
('brand_icbc', 'ICBC', 'icbc.com.cn', 'banking', 'manual', 0),
('brand_bank_of_china', 'Bank of China', 'boc.cn', 'banking', 'manual', 0),
('brand_hdfc', 'HDFC Bank', 'hdfcbank.com', 'banking', 'manual', 0),
('brand_icici', 'ICICI Bank', 'icicibank.com', 'banking', 'manual', 0),
('brand_sbi', 'State Bank of India', 'sbi.co.in', 'banking', 'manual', 0),
('brand_sberbank', 'Sberbank', 'sberbank.ru', 'banking', 'manual', 0),
('brand_tinkoff', 'Tinkoff', 'tinkoff.ru', 'banking', 'manual', 0),
('brand_al_rajhi', 'Al Rajhi Bank', 'alrajhibank.com.sa', 'banking', 'manual', 0),
('brand_emirates_nbd', 'Emirates NBD', 'emiratesnbd.com', 'banking', 'manual', 0),
('brand_qnb', 'QNB', 'qnb.com', 'banking', 'manual', 0);

-- CANADIAN BANKING & FINANCE
INSERT OR IGNORE INTO brands (id, name, canonical_domain, sector, source, threat_count) VALUES
('brand_rbc', 'RBC', 'rbc.com', 'banking_ca', 'manual', 0),
('brand_td', 'TD Bank', 'td.com', 'banking_ca', 'manual', 0),
('brand_scotiabank', 'Scotiabank', 'scotiabank.com', 'banking_ca', 'manual', 0),
('brand_bmo', 'BMO', 'bmo.com', 'banking_ca', 'manual', 0),
('brand_cibc', 'CIBC', 'cibc.com', 'banking_ca', 'manual', 0),
('brand_national_bank', 'National Bank', 'nbc.ca', 'banking_ca', 'manual', 0),
('brand_desjardins', 'Desjardins', 'desjardins.com', 'banking_ca', 'manual', 0),
('brand_tangerine', 'Tangerine', 'tangerine.ca', 'banking_ca', 'manual', 0),
('brand_eq_bank', 'EQ Bank', 'eqbank.ca', 'banking_ca', 'manual', 0),
('brand_simplii', 'Simplii Financial', 'simplii.com', 'banking_ca', 'manual', 0),
('brand_atb', 'ATB Financial', 'atb.com', 'banking_ca', 'manual', 0),
('brand_vancity', 'Vancity', 'vancity.com', 'banking_ca', 'manual', 0),
('brand_meridian', 'Meridian Credit Union', 'meridiancu.ca', 'banking_ca', 'manual', 0);

-- CRYPTO & WEB3
INSERT OR IGNORE INTO brands (id, name, canonical_domain, sector, source, threat_count) VALUES
('brand_binance', 'Binance', 'binance.com', 'crypto', 'manual', 0),
('brand_coinbase', 'Coinbase', 'coinbase.com', 'crypto', 'manual', 0),
('brand_kraken', 'Kraken', 'kraken.com', 'crypto', 'manual', 0),
('brand_okx', 'OKX', 'okx.com', 'crypto', 'manual', 0),
('brand_bybit', 'Bybit', 'bybit.com', 'crypto', 'manual', 0),
('brand_huobi', 'Huobi', 'huobi.com', 'crypto', 'manual', 0),
('brand_crypto_com', 'Crypto.com', 'crypto.com', 'crypto', 'manual', 0),
('brand_gemini', 'Gemini', 'gemini.com', 'crypto', 'manual', 0),
('brand_trezor', 'Trezor', 'trezor.io', 'crypto', 'manual', 0),
('brand_exodus', 'Exodus', 'exodus.com', 'crypto', 'manual', 0),
('brand_trust_wallet', 'Trust Wallet', 'trustwallet.com', 'crypto', 'manual', 0),
('brand_opensea', 'OpenSea', 'opensea.io', 'crypto', 'manual', 0),
('brand_phantom', 'Phantom', 'phantom.app', 'crypto', 'manual', 0);

-- GLOBAL TECH & SOCIAL MEDIA
INSERT OR IGNORE INTO brands (id, name, canonical_domain, sector, source, threat_count) VALUES
('brand_google', 'Google', 'google.com', 'tech', 'manual', 0),
('brand_apple', 'Apple', 'apple.com', 'tech', 'manual', 0),
('brand_microsoft', 'Microsoft', 'microsoft.com', 'tech', 'manual', 0),
('brand_amazon', 'Amazon', 'amazon.com', 'tech', 'manual', 0),
('brand_meta', 'Meta', 'meta.com', 'tech', 'manual', 0),
('brand_netflix', 'Netflix', 'netflix.com', 'tech', 'manual', 0),
('brand_linkedin', 'LinkedIn', 'linkedin.com', 'tech', 'manual', 0),
('brand_tiktok', 'TikTok', 'tiktok.com', 'tech', 'manual', 0),
('brand_snapchat', 'Snapchat', 'snapchat.com', 'tech', 'manual', 0),
('brand_discord', 'Discord', 'discord.com', 'tech', 'manual', 0),
('brand_zoom', 'Zoom', 'zoom.us', 'tech', 'manual', 0),
('brand_dropbox', 'Dropbox', 'dropbox.com', 'tech', 'manual', 0),
('brand_shopify', 'Shopify', 'shopify.com', 'tech', 'manual', 0),
('brand_samsung', 'Samsung', 'samsung.com', 'tech', 'manual', 0),
('brand_huawei', 'Huawei', 'huawei.com', 'tech', 'manual', 0),
('brand_xiaomi', 'Xiaomi', 'mi.com', 'tech', 'manual', 0);

-- E-COMMERCE & RETAIL
INSERT OR IGNORE INTO brands (id, name, canonical_domain, sector, source, threat_count) VALUES
('brand_alibaba', 'Alibaba', 'alibaba.com', 'ecommerce', 'manual', 0),
('brand_aliexpress', 'AliExpress', 'aliexpress.com', 'ecommerce', 'manual', 0),
('brand_jd', 'JD.com', 'jd.com', 'ecommerce', 'manual', 0),
('brand_rakuten', 'Rakuten', 'rakuten.com', 'ecommerce', 'manual', 0),
('brand_mercado_libre', 'Mercado Libre', 'mercadolibre.com', 'ecommerce', 'manual', 0),
('brand_flipkart', 'Flipkart', 'flipkart.com', 'ecommerce', 'manual', 0),
('brand_shopee', 'Shopee', 'shopee.com', 'ecommerce', 'manual', 0),
('brand_asos', 'ASOS', 'asos.com', 'ecommerce', 'manual', 0),
('brand_zalando', 'Zalando', 'zalando.com', 'ecommerce', 'manual', 0),
('brand_walmart', 'Walmart', 'walmart.com', 'ecommerce', 'manual', 0),
('brand_target', 'Target', 'target.com', 'ecommerce', 'manual', 0),
('brand_bestbuy', 'Best Buy', 'bestbuy.com', 'ecommerce', 'manual', 0),
('brand_ikea', 'IKEA', 'ikea.com', 'ecommerce', 'manual', 0),
('brand_shein', 'Shein', 'shein.com', 'ecommerce', 'manual', 0),
('brand_temu', 'Temu', 'temu.com', 'ecommerce', 'manual', 0),
('brand_canadian_tire', 'Canadian Tire', 'canadiantire.ca', 'ecommerce_ca', 'manual', 0),
('brand_shoppers', 'Shoppers Drug Mart', 'shoppersdrugmart.ca', 'ecommerce_ca', 'manual', 0),
('brand_loblaws', 'Loblaws', 'loblaws.ca', 'ecommerce_ca', 'manual', 0),
('brand_tim_hortons', 'Tim Hortons', 'timhortons.com', 'ecommerce_ca', 'manual', 0);

-- STREAMING & ENTERTAINMENT
INSERT OR IGNORE INTO brands (id, name, canonical_domain, sector, source, threat_count) VALUES
('brand_spotify', 'Spotify', 'spotify.com', 'entertainment', 'manual', 0),
('brand_disney_plus', 'Disney+', 'disneyplus.com', 'entertainment', 'manual', 0),
('brand_hbo', 'HBO Max', 'max.com', 'entertainment', 'manual', 0),
('brand_steam', 'Steam', 'steampowered.com', 'entertainment', 'manual', 0),
('brand_playstation', 'PlayStation', 'playstation.com', 'entertainment', 'manual', 0),
('brand_xbox', 'Xbox', 'xbox.com', 'entertainment', 'manual', 0),
('brand_nintendo', 'Nintendo', 'nintendo.com', 'entertainment', 'manual', 0),
('brand_ea', 'EA', 'ea.com', 'entertainment', 'manual', 0),
('brand_epic_games', 'Epic Games', 'epicgames.com', 'entertainment', 'manual', 0),
('brand_roblox', 'Roblox', 'roblox.com', 'entertainment', 'manual', 0);

-- LOGISTICS & SHIPPING
INSERT OR IGNORE INTO brands (id, name, canonical_domain, sector, source, threat_count) VALUES
('brand_fedex', 'FedEx', 'fedex.com', 'logistics', 'manual', 0),
('brand_ups', 'UPS', 'ups.com', 'logistics', 'manual', 0),
('brand_dhl', 'DHL', 'dhl.com', 'logistics', 'manual', 0),
('brand_purolator', 'Purolator', 'purolator.com', 'logistics', 'manual', 0),
('brand_canada_post', 'Canada Post', 'canadapost.ca', 'logistics', 'manual', 0),
('brand_usps', 'USPS', 'usps.com', 'logistics', 'manual', 0),
('brand_royal_mail', 'Royal Mail', 'royalmail.com', 'logistics', 'manual', 0),
('brand_deutsche_post', 'Deutsche Post', 'deutschepost.de', 'logistics', 'manual', 0),
('brand_maersk', 'Maersk', 'maersk.com', 'logistics', 'manual', 0);

-- TRAVEL & HOSPITALITY
INSERT OR IGNORE INTO brands (id, name, canonical_domain, sector, source, threat_count) VALUES
('brand_airbnb', 'Airbnb', 'airbnb.com', 'travel', 'manual', 0),
('brand_booking', 'Booking.com', 'booking.com', 'travel', 'manual', 0),
('brand_expedia', 'Expedia', 'expedia.com', 'travel', 'manual', 0),
('brand_marriott', 'Marriott', 'marriott.com', 'travel', 'manual', 0),
('brand_hilton', 'Hilton', 'hilton.com', 'travel', 'manual', 0),
('brand_air_canada', 'Air Canada', 'aircanada.com', 'travel', 'manual', 0),
('brand_westjet', 'WestJet', 'westjet.com', 'travel', 'manual', 0),
('brand_united', 'United Airlines', 'united.com', 'travel', 'manual', 0),
('brand_delta', 'Delta', 'delta.com', 'travel', 'manual', 0),
('brand_emirates', 'Emirates', 'emirates.com', 'travel', 'manual', 0),
('brand_lufthansa', 'Lufthansa', 'lufthansa.com', 'travel', 'manual', 0),
('brand_british_airways', 'British Airways', 'britishairways.com', 'travel', 'manual', 0),
('brand_singapore_airlines', 'Singapore Airlines', 'singaporeair.com', 'travel', 'manual', 0);

-- GLOBAL TELECOM
INSERT OR IGNORE INTO brands (id, name, canonical_domain, sector, source, threat_count) VALUES
('brand_att', 'AT&T', 'att.com', 'telecom', 'manual', 0),
('brand_verizon', 'Verizon', 'verizon.com', 'telecom', 'manual', 0),
('brand_tmobile', 'T-Mobile', 't-mobile.com', 'telecom', 'manual', 0),
('brand_rogers', 'Rogers', 'rogers.com', 'telecom', 'manual', 0),
('brand_bell', 'Bell', 'bell.ca', 'telecom', 'manual', 0),
('brand_telus', 'Telus', 'telus.com', 'telecom', 'manual', 0),
('brand_fido', 'Fido', 'fido.ca', 'telecom', 'manual', 0),
('brand_koodo', 'Koodo', 'koodomobile.com', 'telecom', 'manual', 0),
('brand_freedom', 'Freedom Mobile', 'freedommobile.ca', 'telecom', 'manual', 0),
('brand_videotron', 'Videotron', 'videotron.com', 'telecom', 'manual', 0),
('brand_vodafone', 'Vodafone', 'vodafone.com', 'telecom', 'manual', 0),
('brand_orange', 'Orange', 'orange.com', 'telecom', 'manual', 0),
('brand_deutsche_telekom', 'Deutsche Telekom', 'telekom.com', 'telecom', 'manual', 0),
('brand_telefonica', 'Telefonica', 'telefonica.com', 'telecom', 'manual', 0),
('brand_china_mobile', 'China Mobile', 'chinamobile.com', 'telecom', 'manual', 0),
('brand_airtel', 'Airtel', 'airtel.com', 'telecom', 'manual', 0),
('brand_jio', 'Reliance Jio', 'jio.com', 'telecom', 'manual', 0),
('brand_mtn', 'MTN', 'mtn.com', 'telecom', 'manual', 0),
('brand_safaricom', 'Safaricom', 'safaricom.com', 'telecom', 'manual', 0);

-- HEALTHCARE & PHARMA
INSERT OR IGNORE INTO brands (id, name, canonical_domain, sector, source, threat_count) VALUES
('brand_cvs', 'CVS', 'cvs.com', 'healthcare', 'manual', 0),
('brand_walgreens', 'Walgreens', 'walgreens.com', 'healthcare', 'manual', 0),
('brand_boots', 'Boots', 'boots.com', 'healthcare', 'manual', 0),
('brand_pfizer', 'Pfizer', 'pfizer.com', 'healthcare', 'manual', 0),
('brand_jnj', 'Johnson & Johnson', 'jnj.com', 'healthcare', 'manual', 0),
('brand_astrazeneca', 'AstraZeneca', 'astrazeneca.com', 'healthcare', 'manual', 0),
('brand_moderna', 'Moderna', 'modernatx.com', 'healthcare', 'manual', 0);

-- CANADIAN GOVERNMENT
INSERT OR IGNORE INTO brands (id, name, canonical_domain, sector, source, threat_count) VALUES
('brand_cra', 'Canada Revenue Agency', 'canada.ca', 'government_ca', 'manual', 0),
('brand_cbsa', 'CBSA', 'cbsa-asfc.gc.ca', 'government_ca', 'manual', 0),
('brand_rcmp', 'RCMP', 'rcmp-grc.gc.ca', 'government_ca', 'manual', 0),
('brand_ircc', 'Immigration Canada', 'ircc.canada.ca', 'government_ca', 'manual', 0),
('brand_ontario_gov', 'Government of Ontario', 'ontario.ca', 'government_ca', 'manual', 0),
('brand_bc_gov', 'Government of BC', 'gov.bc.ca', 'government_ca', 'manual', 0),
('brand_alberta_gov', 'Government of Alberta', 'alberta.ca', 'government_ca', 'manual', 0),
('brand_quebec_gov', 'Government of Quebec', 'gouv.qc.ca', 'government_ca', 'manual', 0);

-- GLOBAL GOVERNMENT & INSTITUTIONS
INSERT OR IGNORE INTO brands (id, name, canonical_domain, sector, source, threat_count) VALUES
('brand_irs', 'IRS', 'irs.gov', 'government', 'manual', 0),
('brand_hmrc', 'HMRC', 'hmrc.gov.uk', 'government', 'manual', 0),
('brand_ato', 'ATO', 'ato.gov.au', 'government', 'manual', 0),
('brand_dhs', 'DHS', 'dhs.gov', 'government', 'manual', 0),
('brand_fbi', 'FBI', 'fbi.gov', 'government', 'manual', 0),
('brand_cisa', 'CISA', 'cisa.gov', 'government', 'manual', 0),
('brand_nhs', 'NHS', 'nhs.uk', 'government', 'manual', 0),
('brand_who', 'WHO', 'who.int', 'government', 'manual', 0),
('brand_un', 'United Nations', 'un.org', 'government', 'manual', 0),
('brand_interpol', 'Interpol', 'interpol.int', 'government', 'manual', 0),
('brand_europol', 'Europol', 'europol.europa.eu', 'government', 'manual', 0),
('brand_nato', 'NATO', 'nato.int', 'government', 'manual', 0),
('brand_imf', 'IMF', 'imf.org', 'government', 'manual', 0),
('brand_world_bank', 'World Bank', 'worldbank.org', 'government', 'manual', 0),
('brand_swift', 'SWIFT', 'swift.com', 'government', 'manual', 0),
('brand_ncsc', 'NCSC UK', 'ncsc.gov.uk', 'government', 'manual', 0),
('brand_cse', 'CSE Canada', 'cse-cst.gc.ca', 'government', 'manual', 0),
('brand_anssi', 'ANSSI France', 'ssi.gouv.fr', 'government', 'manual', 0),
('brand_bsi', 'BSI Germany', 'bsi.bund.de', 'government', 'manual', 0),
('brand_asd', 'ASD Australia', 'asd.gov.au', 'government', 'manual', 0);
