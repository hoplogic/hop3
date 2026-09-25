def transfer(src, dst, /, amount, *extra, currency="CNY", **options):
    """Move amount from src to dst.

    extra holds audit tags; currency is the ISO code; options are passed through.
    """
    return amount


async def fetch(url, *, timeout=10):
    """Fetch url, giving up after timeout seconds."""
    return url


def scale(n):
    """Multiply n by two."""
    return n * 2


class Account:
    """An account."""

    def __init__(self, owner):
        self.owner = owner

    def deposit(self, value):
        """Add value to the balance."""
        return value

    @classmethod
    def build(cls, spec):
        """Create an account from spec."""
        return cls(spec)

    @staticmethod
    def parse(text):
        """Parse text."""
        return text
