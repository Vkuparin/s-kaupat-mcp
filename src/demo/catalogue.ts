import type { Catalogue } from "../client/fixture-client.js";

/**
 * Synthetic sample data for offline development and tests. Not real S-kaupat data: IDs, prices and addresses are made up.
 *
 * Served in demo mode (SKAUPAT_MODE=demo, or the extension's Demo mode) and used by the tests. It is
 * compiled in, so a standalone build needs no data files.
 */
const data = {
  "stores": [
    {
      "id": "fixture-store-1",
      "name": "Prisma Esimerkki Helsinki",
      "chain": "PRISMA",
      "chainName": "Prisma",
      "street": "Testikatu 1",
      "postalCode": "00100",
      "city": "Helsinki",
      "coordinates": {
        "lat": 60.17,
        "lon": 24.94
      },
      "onlineOrdering": true,
      "hours": "ALL_DAY"
    },
    {
      "id": "fixture-store-2",
      "name": "S-market Malli Tampere",
      "chain": "S_MARKET",
      "chainName": "S-market",
      "street": "Mallitie 2",
      "postalCode": "33100",
      "city": "Tampere",
      "coordinates": {
        "lat": 61.5,
        "lon": 23.76
      },
      "onlineOrdering": true,
      "hours": {
        "open": "07:00",
        "close": "22:00"
      }
    },
    {
      "id": "fixture-store-3",
      "name": "Alepa Kokeilu Helsinki",
      "chain": "ALEPA",
      "chainName": "Alepa",
      "street": "Kokeilukuja 3",
      "postalCode": "00500",
      "city": "Helsinki",
      "coordinates": {
        "lat": 60.19,
        "lon": 24.95
      },
      "onlineOrdering": false,
      "hours": {
        "open": "07:00",
        "close": "23:00"
      }
    }
  ],
  "categories": [
    {
      "id": "c1",
      "name": "Maito, munat ja rasvat",
      "slug": "maito-munat-ja-rasvat",
      "children": [
        {
          "id": "c11",
          "name": "Maidot ja piimät",
          "slug": "maito-munat-ja-rasvat/maidot-ja-piimat",
          "children": [
            {
              "id": "c111",
              "name": "Maidot",
              "slug": "maito-munat-ja-rasvat/maidot-ja-piimat/maidot",
              "children": []
            }
          ]
        },
        {
          "id": "c12",
          "name": "Jogurtit ja rahkat",
          "slug": "maito-munat-ja-rasvat/jogurtit-ja-rahkat",
          "children": [
            {
              "id": "c121",
              "name": "Jogurtit",
              "slug": "maito-munat-ja-rasvat/jogurtit-ja-rahkat/jogurtit",
              "children": []
            }
          ]
        }
      ]
    },
    {
      "id": "c2",
      "name": "Leivät, keksit ja leivonnaiset",
      "slug": "leivat-keksit-ja-leivonnaiset",
      "children": [
        {
          "id": "c21",
          "name": "Leivät",
          "slug": "leivat-keksit-ja-leivonnaiset/leivat",
          "children": [
            {
              "id": "c211",
              "name": "Ruisleivät",
              "slug": "leivat-keksit-ja-leivonnaiset/leivat/ruisleivat",
              "children": []
            }
          ]
        }
      ]
    },
    {
      "id": "c3",
      "name": "Hedelmät ja vihannekset",
      "slug": "hedelmat-ja-vihannekset",
      "children": [
        {
          "id": "c31",
          "name": "Hedelmät",
          "slug": "hedelmat-ja-vihannekset/hedelmat",
          "children": []
        }
      ]
    }
  ],
  "products": [
    {
      "id": "0000000000017",
      "sokId": "fixture-sok-1",
      "name": "Kevytmaito 1 l",
      "brand": "Esimerkki",
      "price": 1.09,
      "campaignPrice": null,
      "priceBasis": "per_item",
      "comparisonPrice": 1.09,
      "comparisonUnit": "L",
      "packSize": "1 l",
      "quantityUnit": "KPL",
      "category": "Maidot",
      "categorySlug": "maito-munat-ja-rasvat/maidot-ja-piimat/maidot",
      "details": {
        "description": "Esimerkkimaito testejä varten.",
        "ingredients": "KEVYTMAITO, D-vitamiini.",
        "allergens": [
          {
            "code": "AM",
            "name": "Maito",
            "level": "contains"
          },
          {
            "code": "ML",
            "name": "Laktoosi",
            "level": "contains"
          }
        ],
        "nutrients": [
          {
            "name": "Energia",
            "value": "196 kJ / 47 kcal",
            "referenceIntake": "2,35%",
            "kcal": 47
          },
          {
            "name": "Rasvaa",
            "value": "1,5 g",
            "referenceIntake": "2,14%",
            "kcal": null
          }
        ],
        "countryOfOrigin": "Suomi",
        "supplier": "Esimerkki Oy",
        "netWeightKg": 1.03
      }
    },
    {
      "id": "0000000000024",
      "sokId": "fixture-sok-2",
      "name": "Täysjyväruisleipä 500 g",
      "brand": "Leipomo Malli",
      "price": 2.49,
      "campaignPrice": 1.99,
      "priceBasis": "per_item",
      "comparisonPrice": 4.98,
      "comparisonUnit": "KG",
      "packSize": "500 g",
      "quantityUnit": "KPL",
      "category": "Ruisleivät",
      "categorySlug": "leivat-keksit-ja-leivonnaiset/leivat/ruisleivat"
    },
    {
      "id": "0000000000031",
      "sokId": "fixture-sok-3",
      "name": "Banaani",
      "brand": null,
      "price": 1.79,
      "campaignPrice": null,
      "priceBasis": "per_weight",
      "comparisonPrice": 1.79,
      "comparisonUnit": "KG",
      "packSize": null,
      "quantityUnit": "KG",
      "category": "Hedelmät",
      "categorySlug": "hedelmat-ja-vihannekset/hedelmat"
    },
    {
      "id": "0000000000048",
      "sokId": "fixture-sok-4",
      "name": "Laktoositon maito 1 l",
      "brand": "Esimerkki",
      "price": 1.39,
      "campaignPrice": null,
      "priceBasis": "per_item",
      "comparisonPrice": 1.39,
      "comparisonUnit": "L",
      "packSize": "1 l",
      "quantityUnit": "KPL",
      "category": "Maidot",
      "categorySlug": "maito-munat-ja-rasvat/maidot-ja-piimat/maidot"
    },
    {
      "id": "0000000000055",
      "sokId": "fixture-sok-5",
      "name": "Mansikkajogurtti 150 g",
      "brand": "Esimerkki",
      "price": 0.69,
      "campaignPrice": null,
      "priceBasis": "per_item",
      "comparisonPrice": 4.6,
      "comparisonUnit": "KG",
      "packSize": "150 g",
      "quantityUnit": "KPL",
      "category": "Jogurtit",
      "categorySlug": "maito-munat-ja-rasvat/jogurtit-ja-rahkat/jogurtit",
      "orderable": false
    }
  ]
};

export const DEMO_CATALOGUE = data as unknown as Catalogue;
