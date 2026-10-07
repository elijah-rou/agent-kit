# shop-invoicer

Computes invoice totals for the shop, in cents.

```sh
python3 -m invoicer 40.00 --code SAVE10 --tax 8
```

Discount codes: `SAVE10` takes 10% off, `FLAT5` takes $5.00 off (never below zero).
