from dataclasses import asdict, dataclass
from typing import Any, Optional, Tuple, Type

from diskcache import Cache  # type: ignore

from .seller import profile_url
from .utils import CacheType, cache, hash_dict


@dataclass
class Listing:
    marketplace: str
    name: str
    # unique identification
    id: str
    title: str
    image: str
    price: str
    post_url: str
    location: str
    seller: str
    condition: str
    description: str
    seller_profile: dict[str, Any] | None = None

    @property
    def content(self: "Listing") -> Tuple[str, str, str]:
        return (self.title, self.description, self.price)

    @property
    def hash(self: "Listing") -> str:
        # we need to normalize post_url before hashing because post_url will be different
        # each time from a search page. We also does not count image
        return hash_dict(
            {
                x: (y.split("?")[0] if x == "post_url" else y)
                for x, y in asdict(self).items()
                if x not in {"image", "seller_profile"}
            }
        )

    @classmethod
    def from_cache(
        cls: Type["Listing"],
        post_url: str,
        local_cache: Cache | None = None,
    ) -> Optional["Listing"]:
        try:
            # details could be a different datatype, miss some key etc.
            # and we have recently changed to save Listing as a dictionary
            listing = cls(
                **(cache if local_cache is None else local_cache).get(
                    (CacheType.LISTING_DETAILS.value, post_url.split("?")[0])
                )
            )
            if listing.seller_profile:
                url = profile_url(str(listing.seller_profile.get("profile_url") or ""))
                shared = (
                    (cache if local_cache is None else local_cache).get(
                        (CacheType.SELLER_PROFILE.value, url)
                    )
                    if url
                    else None
                )
                if isinstance(shared, dict) and str(shared.get("checked_at", "")) > str(
                    listing.seller_profile.get("checked_at", "")
                ):
                    listing.seller_profile = shared
            return listing
        except KeyboardInterrupt:
            raise
        except Exception:
            return None

    def to_cache(
        self: "Listing",
        post_url: str,
        local_cache: Cache | None = None,
    ) -> None:
        storage = cache if local_cache is None else local_cache
        with storage.transact():
            storage.set(
                (CacheType.LISTING_DETAILS.value, post_url.split("?")[0]),
                asdict(self),
                tag=CacheType.LISTING_DETAILS.value,
            )
            if self.seller_profile:
                url = profile_url(str(self.seller_profile.get("profile_url") or ""))
                if url:
                    key = (CacheType.SELLER_PROFILE.value, url)
                    previous = storage.get(key)
                    if not isinstance(previous, dict) or str(previous.get("checked_at", "")) < str(
                        self.seller_profile.get("checked_at", "")
                    ):
                        storage.set(key, self.seller_profile, tag=CacheType.SELLER_PROFILE.value)
