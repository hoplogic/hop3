class Session:
    """A session."""

    def open(self, url):
        """Open url."""
        return url

    async def refresh(self, token):
        return token
