-- Events about money that only owner and finance may read (campaign spend, company expenses).
ALTER TABLE events ADD COLUMN audience text;
