import { deepFreeze } from './immutable.mjs';

// Static rule facts transcribed in the project catalog; no third-party code or art.
export const PARK_DATA = deepFreeze([
  {
    "id": "acadia",
    "name": "Acadia",
    "copies": 1,
    "sourceCell": {
      "row": 1,
      "column": 1
    },
    "points": 4,
    "cost": {
      "mountain": 0,
      "forest": 1,
      "sun": 0,
      "water": 1,
      "wildlife": 1
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "arches",
    "name": "Arches",
    "copies": 1,
    "sourceCell": {
      "row": 1,
      "column": 2
    },
    "points": 3,
    "cost": {
      "mountain": 1,
      "forest": 0,
      "sun": 2,
      "water": 0,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "badlands",
    "name": "Badlands",
    "copies": 1,
    "sourceCell": {
      "row": 1,
      "column": 3
    },
    "points": 7,
    "cost": {
      "mountain": 2,
      "forest": 1,
      "sun": 4,
      "water": 0,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "big-bend",
    "name": "Big Bend",
    "copies": 1,
    "sourceCell": {
      "row": 1,
      "column": 4
    },
    "points": 5,
    "cost": {
      "mountain": 1,
      "forest": 0,
      "sun": 3,
      "water": 2,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "gain_resources",
      "resources": {
        "wildlife": 1
      }
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "biscayne",
    "name": "Biscayne",
    "copies": 1,
    "sourceCell": {
      "row": 1,
      "column": 5
    },
    "points": 3,
    "cost": {
      "mountain": 0,
      "forest": 2,
      "sun": 0,
      "water": 1,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "gain_canteen",
      "amount": 1
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "black-canyon-of-the-gunnison",
    "name": "Black Canyon of the Gunnison",
    "copies": 1,
    "sourceCell": {
      "row": 1,
      "column": 6
    },
    "points": 4,
    "cost": {
      "mountain": 2,
      "forest": 0,
      "sun": 0,
      "water": 2,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "bryce-canyon",
    "name": "Bryce Canyon",
    "copies": 1,
    "sourceCell": {
      "row": 1,
      "column": 7
    },
    "points": 7,
    "cost": {
      "mountain": 4,
      "forest": 0,
      "sun": 2,
      "water": 0,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "canyonlands",
    "name": "Canyonlands",
    "copies": 1,
    "sourceCell": {
      "row": 2,
      "column": 1
    },
    "points": 3,
    "cost": {
      "mountain": 2,
      "forest": 0,
      "sun": 1,
      "water": 0,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "gain_resources",
      "resources": {
        "wildlife": 1
      }
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "capitol-reef",
    "name": "Capitol Reef",
    "copies": 1,
    "sourceCell": {
      "row": 2,
      "column": 2
    },
    "points": 5,
    "cost": {
      "mountain": 1,
      "forest": 1,
      "sun": 1,
      "water": 1,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "carlsbad-caverns",
    "name": "Carlsbad Caverns",
    "copies": 1,
    "sourceCell": {
      "row": 2,
      "column": 3
    },
    "points": 2,
    "cost": {
      "mountain": 1,
      "forest": 0,
      "sun": 1,
      "water": 0,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "gain_resources",
      "resources": {
        "wildlife": 1
      }
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "channel-islands",
    "name": "Channel Islands",
    "copies": 1,
    "sourceCell": {
      "row": 2,
      "column": 4
    },
    "points": 3,
    "cost": {
      "mountain": 1,
      "forest": 0,
      "sun": 0,
      "water": 3,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "gain_resources",
      "resources": {
        "sun": 2
      }
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "congaree",
    "name": "Congaree",
    "copies": 1,
    "sourceCell": {
      "row": 2,
      "column": 5
    },
    "points": 3,
    "cost": {
      "mountain": 0,
      "forest": 2,
      "sun": 0,
      "water": 0,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "crater-lake",
    "name": "Crater Lake",
    "copies": 1,
    "sourceCell": {
      "row": 2,
      "column": 6
    },
    "points": 3,
    "cost": {
      "mountain": 1,
      "forest": 1,
      "sun": 0,
      "water": 1,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "take_shutterbug_badge"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "cuyahoga-valley",
    "name": "Cuyahoga Valley",
    "copies": 1,
    "sourceCell": {
      "row": 2,
      "column": 7
    },
    "points": 3,
    "cost": {
      "mountain": 0,
      "forest": 1,
      "sun": 0,
      "water": 2,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "death-valley",
    "name": "Death Valley",
    "copies": 1,
    "sourceCell": {
      "row": 3,
      "column": 1
    },
    "points": 3,
    "cost": {
      "mountain": 0,
      "forest": 0,
      "sun": 4,
      "water": 0,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "denali",
    "name": "Denali",
    "copies": 1,
    "sourceCell": {
      "row": 3,
      "column": 2
    },
    "points": 6,
    "cost": {
      "mountain": 1,
      "forest": 1,
      "sun": 2,
      "water": 2,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "dry-tortugas",
    "name": "Dry Tortugas",
    "copies": 1,
    "sourceCell": {
      "row": 3,
      "column": 3
    },
    "points": 2,
    "cost": {
      "mountain": 0,
      "forest": 0,
      "sun": 0,
      "water": 3,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "gain_resources",
      "resources": {
        "sun": 2
      }
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "everglades",
    "name": "Everglades",
    "copies": 1,
    "sourceCell": {
      "row": 3,
      "column": 4
    },
    "points": 3,
    "cost": {
      "mountain": 0,
      "forest": 0,
      "sun": 0,
      "water": 4,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "gates-of-the-arctic",
    "name": "Gates of the Arctic",
    "copies": 1,
    "sourceCell": {
      "row": 3,
      "column": 5
    },
    "points": 3,
    "cost": {
      "mountain": 0,
      "forest": 0,
      "sun": 3,
      "water": 1,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "gateway-arch",
    "name": "Gateway Arch",
    "copies": 1,
    "sourceCell": {
      "row": 3,
      "column": 6
    },
    "points": 2,
    "cost": {
      "mountain": 0,
      "forest": 0,
      "sun": 3,
      "water": 0,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "gain_resources",
      "resources": {
        "water": 2
      }
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "glacier",
    "name": "Glacier",
    "copies": 1,
    "sourceCell": {
      "row": 3,
      "column": 7
    },
    "points": 4,
    "cost": {
      "mountain": 2,
      "forest": 0,
      "sun": 1,
      "water": 1,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "take_shutterbug_badge"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "glacier-bay",
    "name": "Glacier Bay",
    "copies": 1,
    "sourceCell": {
      "row": 4,
      "column": 1
    },
    "points": 6,
    "cost": {
      "mountain": 1,
      "forest": 0,
      "sun": 0,
      "water": 3,
      "wildlife": 1
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "grand-canyon",
    "name": "Grand Canyon",
    "copies": 1,
    "sourceCell": {
      "row": 4,
      "column": 2
    },
    "points": 7,
    "cost": {
      "mountain": 4,
      "forest": 1,
      "sun": 0,
      "water": 0,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "grand-teton",
    "name": "Grand Teton",
    "copies": 1,
    "sourceCell": {
      "row": 4,
      "column": 3
    },
    "points": 3,
    "cost": {
      "mountain": 1,
      "forest": 1,
      "sun": 1,
      "water": 0,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "roll_trail_die",
      "times": 1
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "great-basin",
    "name": "Great Basin",
    "copies": 1,
    "sourceCell": {
      "row": 4,
      "column": 4
    },
    "points": 4,
    "cost": {
      "mountain": 2,
      "forest": 1,
      "sun": 1,
      "water": 0,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "gain_resources",
      "resources": {
        "water": 2
      }
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "great-sand-dunes",
    "name": "Great Sand Dunes",
    "copies": 1,
    "sourceCell": {
      "row": 4,
      "column": 5
    },
    "points": 6,
    "cost": {
      "mountain": 3,
      "forest": 0,
      "sun": 3,
      "water": 0,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "gain_resources",
      "resources": {
        "water": 1
      }
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "great-smoky-mountains",
    "name": "Great Smoky Mountains",
    "copies": 1,
    "sourceCell": {
      "row": 4,
      "column": 6
    },
    "points": 7,
    "cost": {
      "mountain": 2,
      "forest": 2,
      "sun": 1,
      "water": 1,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "guadalupe-mountains",
    "name": "Guadalupe Mountains",
    "copies": 1,
    "sourceCell": {
      "row": 4,
      "column": 7
    },
    "points": 4,
    "cost": {
      "mountain": 1,
      "forest": 0,
      "sun": 1,
      "water": 0,
      "wildlife": 1
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "haleakala",
    "name": "Haleakalā",
    "copies": 1,
    "sourceCell": {
      "row": 5,
      "column": 1
    },
    "points": 5,
    "cost": {
      "mountain": 4,
      "forest": 0,
      "sun": 0,
      "water": 0,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "hawaii-volcanoes",
    "name": "Hawaiʻi Volcanoes",
    "copies": 1,
    "sourceCell": {
      "row": 5,
      "column": 2
    },
    "points": 4,
    "cost": {
      "mountain": 3,
      "forest": 0,
      "sun": 0,
      "water": 1,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "roll_trail_die",
      "times": 1
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "hot-springs",
    "name": "Hot Springs",
    "copies": 1,
    "sourceCell": {
      "row": 5,
      "column": 3
    },
    "points": 3,
    "cost": {
      "mountain": 0,
      "forest": 0,
      "sun": 1,
      "water": 3,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "indiana-dunes",
    "name": "Indiana Dunes",
    "copies": 1,
    "sourceCell": {
      "row": 5,
      "column": 4
    },
    "points": 3,
    "cost": {
      "mountain": 1,
      "forest": 0,
      "sun": 1,
      "water": 2,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "gain_resources",
      "resources": {
        "wildlife": 1
      }
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "isle-royale",
    "name": "Isle Royale",
    "copies": 1,
    "sourceCell": {
      "row": 5,
      "column": 5
    },
    "points": 2,
    "cost": {
      "mountain": 0,
      "forest": 1,
      "sun": 0,
      "water": 1,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "gain_canteen",
      "amount": 1
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "joshua-tree",
    "name": "Joshua Tree",
    "copies": 1,
    "sourceCell": {
      "row": 5,
      "column": 6
    },
    "points": 3,
    "cost": {
      "mountain": 0,
      "forest": 1,
      "sun": 3,
      "water": 0,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "gain_resources",
      "resources": {
        "water": 2
      }
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "katmai",
    "name": "Katmai",
    "copies": 1,
    "sourceCell": {
      "row": 5,
      "column": 7
    },
    "points": 3,
    "cost": {
      "mountain": 0,
      "forest": 0,
      "sun": 0,
      "water": 1,
      "wildlife": 1
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "kenai-fjords",
    "name": "Kenai Fjords",
    "copies": 1,
    "sourceCell": {
      "row": 6,
      "column": 1
    },
    "points": 5,
    "cost": {
      "mountain": 3,
      "forest": 1,
      "sun": 0,
      "water": 1,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "gain_resources",
      "resources": {
        "sun": 2
      }
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "kings-canyon",
    "name": "Kings Canyon",
    "copies": 1,
    "sourceCell": {
      "row": 6,
      "column": 2
    },
    "points": 4,
    "cost": {
      "mountain": 1,
      "forest": 2,
      "sun": 0,
      "water": 1,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "gain_resources",
      "resources": {
        "sun": 2
      }
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "kobuk-valley",
    "name": "Kobuk Valley",
    "copies": 1,
    "sourceCell": {
      "row": 6,
      "column": 3
    },
    "points": 3,
    "cost": {
      "mountain": 0,
      "forest": 1,
      "sun": 2,
      "water": 1,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "gain_canteen",
      "amount": 1
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "lake-clark",
    "name": "Lake Clark",
    "copies": 1,
    "sourceCell": {
      "row": 6,
      "column": 4
    },
    "points": 3,
    "cost": {
      "mountain": 1,
      "forest": 0,
      "sun": 0,
      "water": 2,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "lassen-volcanic",
    "name": "Lassen Volcanic",
    "copies": 1,
    "sourceCell": {
      "row": 6,
      "column": 5
    },
    "points": 4,
    "cost": {
      "mountain": 0,
      "forest": 3,
      "sun": 0,
      "water": 0,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "mammoth-cave",
    "name": "Mammoth Cave",
    "copies": 1,
    "sourceCell": {
      "row": 6,
      "column": 6
    },
    "points": 3,
    "cost": {
      "mountain": 2,
      "forest": 0,
      "sun": 0,
      "water": 0,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "mesa-verde",
    "name": "Mesa Verde",
    "copies": 1,
    "sourceCell": {
      "row": 6,
      "column": 7
    },
    "points": 6,
    "cost": {
      "mountain": 3,
      "forest": 1,
      "sun": 1,
      "water": 0,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "mount-rainier",
    "name": "Mount Rainier",
    "copies": 1,
    "sourceCell": {
      "row": 7,
      "column": 1
    },
    "points": 5,
    "cost": {
      "mountain": 1,
      "forest": 3,
      "sun": 0,
      "water": 1,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "gain_resources",
      "resources": {
        "wildlife": 1
      }
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "american-samoa",
    "name": "National Park of American Samoa",
    "copies": 1,
    "sourceCell": {
      "row": 7,
      "column": 2
    },
    "points": 6,
    "cost": {
      "mountain": 0,
      "forest": 1,
      "sun": 3,
      "water": 0,
      "wildlife": 1
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "new-river-gorge",
    "name": "New River Gorge",
    "copies": 1,
    "sourceCell": {
      "row": 7,
      "column": 3
    },
    "points": 5,
    "cost": {
      "mountain": 0,
      "forest": 1,
      "sun": 2,
      "water": 3,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "gain_canteen",
      "amount": 1
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "north-cascades",
    "name": "North Cascades",
    "copies": 1,
    "sourceCell": {
      "row": 7,
      "column": 4
    },
    "points": 7,
    "cost": {
      "mountain": 1,
      "forest": 2,
      "sun": 0,
      "water": 4,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "olympic",
    "name": "Olympic",
    "copies": 1,
    "sourceCell": {
      "row": 7,
      "column": 5
    },
    "points": 4,
    "cost": {
      "mountain": 0,
      "forest": 3,
      "sun": 1,
      "water": 0,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "roll_trail_die",
      "times": 1
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "petrified-forest",
    "name": "Petrified Forest",
    "copies": 1,
    "sourceCell": {
      "row": 7,
      "column": 6
    },
    "points": 4,
    "cost": {
      "mountain": 0,
      "forest": 2,
      "sun": 2,
      "water": 0,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "pinnacles",
    "name": "Pinnacles",
    "copies": 1,
    "sourceCell": {
      "row": 7,
      "column": 7
    },
    "points": 4,
    "cost": {
      "mountain": 3,
      "forest": 0,
      "sun": 1,
      "water": 0,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "roll_trail_die",
      "times": 1
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "redwood",
    "name": "Redwood",
    "copies": 1,
    "sourceCell": {
      "row": 8,
      "column": 1
    },
    "points": 7,
    "cost": {
      "mountain": 1,
      "forest": 4,
      "sun": 0,
      "water": 0,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "rocky-mountain",
    "name": "Rocky Mountain",
    "copies": 1,
    "sourceCell": {
      "row": 8,
      "column": 2
    },
    "points": 6,
    "cost": {
      "mountain": 1,
      "forest": 1,
      "sun": 2,
      "water": 2,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "saguaro",
    "name": "Saguaro",
    "copies": 1,
    "sourceCell": {
      "row": 8,
      "column": 3
    },
    "points": 3,
    "cost": {
      "mountain": 0,
      "forest": 1,
      "sun": 2,
      "water": 0,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "sequoia",
    "name": "Sequoia",
    "copies": 1,
    "sourceCell": {
      "row": 8,
      "column": 4
    },
    "points": 5,
    "cost": {
      "mountain": 0,
      "forest": 4,
      "sun": 0,
      "water": 0,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "shenandoah",
    "name": "Shenandoah",
    "copies": 1,
    "sourceCell": {
      "row": 8,
      "column": 5
    },
    "points": 4,
    "cost": {
      "mountain": 0,
      "forest": 2,
      "sun": 1,
      "water": 1,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "take_shutterbug_badge"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "theodore-roosevelt",
    "name": "Theodore Roosevelt",
    "copies": 1,
    "sourceCell": {
      "row": 8,
      "column": 6
    },
    "points": 5,
    "cost": {
      "mountain": 1,
      "forest": 3,
      "sun": 1,
      "water": 0,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "gain_resources",
      "resources": {
        "water": 2
      }
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "virgin-islands",
    "name": "Virgin Islands",
    "copies": 1,
    "sourceCell": {
      "row": 8,
      "column": 7
    },
    "points": 4,
    "cost": {
      "mountain": 0,
      "forest": 0,
      "sun": 2,
      "water": 1,
      "wildlife": 1
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "voyageurs",
    "name": "Voyageurs",
    "copies": 1,
    "sourceCell": {
      "row": 9,
      "column": 1
    },
    "points": 6,
    "cost": {
      "mountain": 0,
      "forest": 3,
      "sun": 0,
      "water": 3,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "gain_resources",
      "resources": {
        "sun": 1
      }
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "white-sands",
    "name": "White Sands",
    "copies": 1,
    "sourceCell": {
      "row": 9,
      "column": 2
    },
    "points": 3,
    "cost": {
      "mountain": 0,
      "forest": 0,
      "sun": 1,
      "water": 0,
      "wildlife": 1
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "wind-cave",
    "name": "Wind Cave",
    "copies": 1,
    "sourceCell": {
      "row": 9,
      "column": 3
    },
    "points": 4,
    "cost": {
      "mountain": 0,
      "forest": 3,
      "sun": 0,
      "water": 1,
      "wildlife": 0
    },
    "hasInstantAction": true,
    "instantEffect": {
      "type": "take_shutterbug_badge"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "wrangell-st-elias",
    "name": "Wrangell–St. Elias",
    "copies": 1,
    "sourceCell": {
      "row": 9,
      "column": 4
    },
    "points": 7,
    "cost": {
      "mountain": 0,
      "forest": 4,
      "sun": 0,
      "water": 2,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "yellowstone",
    "name": "Yellowstone",
    "copies": 1,
    "sourceCell": {
      "row": 9,
      "column": 5
    },
    "points": 6,
    "cost": {
      "mountain": 0,
      "forest": 0,
      "sun": 2,
      "water": 3,
      "wildlife": 1
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "yosemite",
    "name": "Yosemite",
    "copies": 1,
    "sourceCell": {
      "row": 9,
      "column": 6
    },
    "points": 6,
    "cost": {
      "mountain": 1,
      "forest": 1,
      "sun": 1,
      "water": 1,
      "wildlife": 1
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  },
  {
    "id": "zion",
    "name": "Zion",
    "copies": 1,
    "sourceCell": {
      "row": 9,
      "column": 7
    },
    "points": 4,
    "cost": {
      "mountain": 3,
      "forest": 0,
      "sun": 0,
      "water": 0,
      "wildlife": 0
    },
    "hasInstantAction": false,
    "instantEffect": {
      "type": "none"
    },
    "needsReview": false,
    "reviewNotes": []
  }
]);
