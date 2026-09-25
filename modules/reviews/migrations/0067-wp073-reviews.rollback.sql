DROP TABLE IF EXISTS reviews.review_private_hold;
DROP TABLE IF EXISTS reviews.review_response;
DROP TABLE IF EXISTS reviews.review_invite;
DROP SCHEMA IF EXISTS reviews;
REVOKE module_reviews FROM practicehub_app;
