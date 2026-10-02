import { FoodView } from "./FoodView";

export const metadata = { title: "Humane Center" };

/**
 * Food & nutrition. The Pin's food experience tells the wearer to add goals
 * "in dot center" (`humane_food` strings), and no Pin process writes them: this
 * page is their editor, over Cosmos's `/account-service/food-preferences`.
 */
export default function FoodPage() {
  return <FoodView />;
}
